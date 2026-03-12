import { NextResponse } from 'next/server'
import { normalizePaymentCurrency, validateStripeSettlement } from '@/app/lib/server/payment-helpers'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'
import { handleStripeWebhookRequest } from './handler'

const WEBHOOK_SECRET = String(process.env.STRIPE_WEBHOOK_SECRET ?? '').trim()

function toInt(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.trunc(n)
}

function asRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return { ...(value as Record<string, unknown>) }
}

type StripeEvent = {
  id: string
  type: string
  data?: { object?: Record<string, unknown> }
}

type PaymentEventRow = {
  id: string
  status: string
}

type PaymentRequestRow = {
  id: string
  case_id: string
  amount_cents: number
  currency: string
  status: string
  metadata: Record<string, unknown> | null
}

async function beginStripeEventProcessing(params: { event: StripeEvent }) {
  const supabase = createServiceRoleClient()

  const existing = await supabase
    .from('payment_events')
    .select('id, status')
    .eq('provider', 'STRIPE')
    .eq('provider_event_id', params.event.id)
    .maybeSingle<PaymentEventRow>()
  if (existing.error) {
    throw new Error(existing.error.message)
  }

  if (existing.data) {
    const status = String(existing.data.status ?? '').toUpperCase()
    if (status === 'PROCESSED' || status === 'IGNORED') {
      return { duplicate: true as const, eventRowId: existing.data.id }
    }

    const retryUpdate = await supabase
      .from('payment_events')
      .update({
        type: params.event.type,
        payload: params.event,
        status: 'RECEIVED',
        error_text: null,
        processed_at: null,
      })
      .eq('id', existing.data.id)
    if (retryUpdate.error) {
      throw new Error(retryUpdate.error.message)
    }

    return { duplicate: false as const, eventRowId: existing.data.id }
  }

  const insert = await supabase
    .from('payment_events')
    .insert({
      provider: 'STRIPE',
      provider_event_id: params.event.id,
      type: params.event.type,
      payload: params.event,
      status: 'RECEIVED',
    })
    .select('id')
    .single<{ id: string }>()
  if (!insert.error && insert.data?.id) {
    return { duplicate: false as const, eventRowId: insert.data.id }
  }

  if (insert.error && /duplicate key value|already exists|unique/i.test(insert.error.message)) {
    return beginStripeEventProcessing(params)
  }

  throw new Error(insert.error?.message || 'Could not record Stripe webhook event.')
}

async function updateStripeEventStatus(params: {
  supabase: ReturnType<typeof createServiceRoleClient>
  eventRowId: string
  status: 'PROCESSED' | 'IGNORED' | 'FAILED'
  errorText?: string | null
  payload?: unknown
}) {
  const update = await params.supabase
    .from('payment_events')
    .update({
      status: params.status,
      processed_at: new Date().toISOString(),
      error_text: params.errorText ?? null,
      ...(params.payload === undefined ? {} : { payload: params.payload }),
    })
    .eq('id', params.eventRowId)

  if (update.error) {
    throw new Error(update.error.message)
  }
}

function getStripeCheckoutContext(event: StripeEvent) {
  const object = event.data?.object ?? {}
  const metadata =
    object['metadata'] && typeof object['metadata'] === 'object' && !Array.isArray(object['metadata'])
      ? (object['metadata'] as Record<string, unknown>)
      : {}
  const customerDetails =
    object['customer_details'] && typeof object['customer_details'] === 'object'
      ? (object['customer_details'] as Record<string, unknown>)
      : {}

  return {
    object,
    metadata,
    paymentRequestId: String(metadata['payment_request_id'] ?? '').trim(),
    caseId: String(metadata['case_id'] ?? '').trim(),
    checkoutSessionId: String(object['id'] ?? '').trim(),
    paymentIntentId:
      String(object['payment_intent'] ?? '').trim() ||
      (String(object['id'] ?? '').trim() ? `session:${String(object['id'] ?? '').trim()}` : ''),
    amountCents: toInt(object['amount_total']),
    currency: normalizePaymentCurrency(object['currency']),
    customerEmail: String(customerDetails['email'] ?? '').trim() || null,
  }
}

async function loadPaymentRequest(params: {
  supabase: ReturnType<typeof createServiceRoleClient>
  paymentRequestId: string
  caseId: string
}) {
  const requestRow = await params.supabase
    .from('payment_requests')
    .select('id, case_id, amount_cents, currency, status, metadata')
    .eq('id', params.paymentRequestId)
    .eq('case_id', params.caseId)
    .maybeSingle<PaymentRequestRow>()

  if (requestRow.error || !requestRow.data) {
    throw new Error(requestRow.error?.message || 'Payment request not found.')
  }

  return requestRow.data
}

async function processCompletedCheckout(params: {
  supabase: ReturnType<typeof createServiceRoleClient>
  event: StripeEvent
  eventRowId: string
}) {
  const context = getStripeCheckoutContext(params.event)
  if (!context.paymentRequestId || !context.caseId || !context.paymentIntentId || !context.amountCents || context.amountCents <= 0) {
    throw new Error('Stripe checkout payload is missing payment_request_id, case_id, payment_intent, or amount.')
  }

  const requestRow = await loadPaymentRequest({
    supabase: params.supabase,
    paymentRequestId: context.paymentRequestId,
    caseId: context.caseId,
  })

  const validationError = validateStripeSettlement({
    expectedCaseId: requestRow.case_id,
    expectedAmountCents: requestRow.amount_cents,
    expectedCurrency: requestRow.currency,
    actualCaseId: context.caseId,
    actualAmountCents: context.amountCents,
    actualCurrency: context.currency,
  })
  if (validationError) {
    throw new Error(validationError)
  }

  const paymentInsert = await params.supabase
    .from('payments')
    .upsert(
      {
        payment_request_id: context.paymentRequestId,
        case_id: context.caseId,
        payer_user_id: null,
        provider: 'STRIPE',
        provider_payment_intent_id: context.paymentIntentId,
        provider_checkout_session_id: context.checkoutSessionId || null,
        amount_cents: context.amountCents,
        currency: context.currency,
        status: 'SUCCEEDED',
        captured_at: new Date().toISOString(),
        metadata: {
          stripe_event_id: params.event.id,
          customer_email: context.customerEmail,
        },
      },
      {
        onConflict: 'provider,provider_payment_intent_id',
      }
    )
    .select('id')
    .single<{ id: string }>()
  if (paymentInsert.error || !paymentInsert.data?.id) {
    throw new Error(paymentInsert.error?.message || 'Payment upsert failed.')
  }

  const requestUpdate = await params.supabase
    .from('payment_requests')
    .update({
      status: 'PAID',
      paid_at: new Date().toISOString(),
      provider: 'STRIPE',
      provider_checkout_session_id: context.checkoutSessionId || null,
      provider_payment_intent_id: context.paymentIntentId,
      metadata: {
        ...asRecord(requestRow.metadata),
        settled_by_event_id: params.event.id,
        customer_email: context.customerEmail,
      },
    })
    .eq('id', context.paymentRequestId)
  if (requestUpdate.error) {
    throw new Error(requestUpdate.error.message)
  }

  const ledgerInsert = await params.supabase.from('case_financial_ledger').insert({
    case_id: context.caseId,
    entry_type: 'CREDIT',
    amount_cents: context.amountCents,
    currency: context.currency,
    source_table: 'payments',
    source_id: paymentInsert.data.id,
    description: 'Stripe checkout payment settled.',
    metadata: {
      payment_request_id: context.paymentRequestId,
      stripe_event_id: params.event.id,
      stripe_payment_intent_id: context.paymentIntentId,
    },
  })
  if (ledgerInsert.error && !/duplicate key value|already exists|unique/i.test(ledgerInsert.error.message)) {
    throw new Error(ledgerInsert.error.message)
  }

  const recalc = await params.supabase.rpc('recalculate_case_financials', { p_case_id: context.caseId })
  if (recalc.error) {
    throw new Error(recalc.error.message)
  }

  const caseEventInsert = await params.supabase.from('case_events').insert({
    case_id: context.caseId,
    actor_id: null,
    event_type: 'PAYMENT_SETTLED',
    event_summary: `Stripe payment settled (${(context.amountCents / 100).toFixed(2)} ${context.currency.toUpperCase()}).`,
    metadata: {
      payment_request_id: context.paymentRequestId,
      stripe_event_id: params.event.id,
      stripe_checkout_session_id: context.checkoutSessionId || null,
    },
  })
  if (caseEventInsert.error) {
    throw new Error(caseEventInsert.error.message)
  }

  await updateStripeEventStatus({
    supabase: params.supabase,
    eventRowId: params.eventRowId,
    status: 'PROCESSED',
  })
}

async function processExpiredCheckout(params: {
  supabase: ReturnType<typeof createServiceRoleClient>
  event: StripeEvent
  eventRowId: string
}) {
  const context = getStripeCheckoutContext(params.event)
  if (!context.paymentRequestId || !context.caseId) {
    throw new Error('Stripe checkout expiration payload is missing payment_request_id or case_id.')
  }

  const requestRow = await loadPaymentRequest({
    supabase: params.supabase,
    paymentRequestId: context.paymentRequestId,
    caseId: context.caseId,
  })

  if (String(requestRow.status ?? '').toUpperCase() !== 'PAID') {
    const requestUpdate = await params.supabase
      .from('payment_requests')
      .update({
        status: 'EXPIRED',
        provider: 'STRIPE',
        provider_checkout_session_id: context.checkoutSessionId || null,
        metadata: {
          ...asRecord(requestRow.metadata),
          expired_by_event_id: params.event.id,
        },
      })
      .eq('id', context.paymentRequestId)

    if (requestUpdate.error) {
      throw new Error(requestUpdate.error.message)
    }

    const caseEventInsert = await params.supabase.from('case_events').insert({
      case_id: context.caseId,
      actor_id: null,
      event_type: 'PAYMENT_REQUEST_EXPIRED',
      event_summary: 'Stripe checkout session expired before payment completed.',
      metadata: {
        payment_request_id: context.paymentRequestId,
        stripe_event_id: params.event.id,
        stripe_checkout_session_id: context.checkoutSessionId || null,
      },
    })
    if (caseEventInsert.error) {
      throw new Error(caseEventInsert.error.message)
    }
  }

  await updateStripeEventStatus({
    supabase: params.supabase,
    eventRowId: params.eventRowId,
    status: 'PROCESSED',
  })
}

async function processStripeEvent(event: StripeEvent, rawBody: string) {
  const supabase = createServiceRoleClient()
  const processing = await beginStripeEventProcessing({ event })
  if (processing.duplicate) {
    return { duplicate: true }
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await processCompletedCheckout({
        supabase,
        event,
        eventRowId: processing.eventRowId,
      })
      return { duplicate: false }
    }

    if (event.type === 'checkout.session.expired') {
      await processExpiredCheckout({
        supabase,
        event,
        eventRowId: processing.eventRowId,
      })
      return { duplicate: false }
    }

    await updateStripeEventStatus({
      supabase,
      eventRowId: processing.eventRowId,
      status: 'IGNORED',
      errorText: `Unhandled event type: ${event.type}`,
    })
    return { duplicate: false }
  } catch (error) {
    await updateStripeEventStatus({
      supabase,
      eventRowId: processing.eventRowId,
      status: 'FAILED',
      errorText: error instanceof Error ? error.message : String(error),
      payload: rawBody,
    })
    throw error
  }
}

async function run(request: Request) {
  const rawBody = await request.text()
  const signatureHeader = String(request.headers.get('stripe-signature') ?? '')

  try {
    const result = await handleStripeWebhookRequest({
      method: request.method,
      rawBody,
      signatureHeader,
      webhookSecret: WEBHOOK_SECRET,
      onEvent: processStripeEvent,
    })
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Stripe webhook processing failed.',
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  return run(request)
}
