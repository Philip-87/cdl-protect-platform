import { NextResponse } from 'next/server'
import {
  asPaymentMetadata,
  buildLawPayPaymentKey,
  classifyLawPayProcessingState,
  extractStoredLawPayCharge,
  type PaymentMetadata,
  type StoredLawPayCharge,
} from '@/app/lib/server/payment-helpers'
import { findLatestPaymentRequestIdForQuoteSafe } from '@/app/lib/server/quote-payment'
import { createLawPayCharge, type LawPayMethodType } from '@/app/lib/server/lawpay'
import { handleQuotePaymentCompletion } from '@/app/lib/matching/attorneyMatching'
import { createClient } from '@/app/lib/supabase/server'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'

export const runtime = 'nodejs'

type ChargeRequestBody = {
  quoteId?: string
  methodType?: LawPayMethodType
  methodTokenId?: string
  billing?: Record<string, unknown>
}

type QuoteRow = {
  id: string
  case_id: string
  total_cents: number
  status: string
}

type LawPayPaymentRow = {
  id: string
  status: string
  updated_at: string | null
  metadata: PaymentMetadata | null
}

type LawPayProcessingResult =
  | { kind: 'busy' }
  | { kind: 'acquired'; paymentId: string; metadata: PaymentMetadata }
  | { kind: 'resume'; paymentId: string; metadata: PaymentMetadata; charge: StoredLawPayCharge }
  | { kind: 'duplicate'; paymentId: string; metadata: PaymentMetadata; charge: StoredLawPayCharge | null }

function lawPayMetadata(base: unknown, extra: PaymentMetadata) {
  return {
    ...asPaymentMetadata(base),
    ...extra,
  }
}

async function findLatestPaymentRequestIdForQuote(
  admin: ReturnType<typeof createServiceRoleClient>,
  caseId: string,
  quoteId: string
) {
  const paymentRequest = await findLatestPaymentRequestIdForQuoteSafe({
    admin,
    caseId,
    quoteId,
  })

  if (!paymentRequest.ok) {
    throw new Error(paymentRequest.error)
  }

  return paymentRequest.paymentRequestId
}

async function markCasePaid(caseId: string) {
  const admin = createServiceRoleClient()

  const transition = await admin.rpc('transition_case_status', {
    p_case_id: caseId,
    p_to_status: 'PAID',
    p_reason: 'LAWPAY_CHARGE_SUCCEEDED',
    p_metadata: {},
  })
  if (!transition.error) return

  const caseUpdate = await admin
    .from('cases')
    .update({
      status: 'PAID',
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseId)
  if (caseUpdate.error) {
    throw new Error(caseUpdate.error.message)
  }
}

async function beginLawPayChargeProcessing(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  quote: QuoteRow
  payerUserId: string
  methodType: LawPayMethodType
  billing: Record<string, unknown>
}) {
  const { admin } = params
  const paymentKey = buildLawPayPaymentKey(params.quote.id)
  const paymentRequestId = await findLatestPaymentRequestIdForQuote(admin, params.quote.case_id, params.quote.id)
  const nowIso = new Date().toISOString()
  const attemptMetadata = {
    quote_id: params.quote.id,
    payment_request_id: paymentRequestId,
    method_type: params.methodType,
    billing: params.billing,
    last_attempt_at: nowIso,
  }

  while (true) {
    const existing = await admin
      .from('payments')
      .select('id, status, updated_at, metadata')
      .eq('provider', 'LAWPAY')
      .eq('provider_payment_intent_id', paymentKey)
      .maybeSingle<LawPayPaymentRow>()
    if (existing.error) {
      throw new Error(existing.error.message)
    }

    if (existing.data) {
      const metadata = asPaymentMetadata(existing.data.metadata)
      const state = classifyLawPayProcessingState({
        status: existing.data.status,
        updatedAt: existing.data.updated_at,
        metadata,
      })

      if (state === 'SUCCEEDED') {
        return {
          kind: 'duplicate',
          paymentId: existing.data.id,
          metadata,
          charge: extractStoredLawPayCharge(metadata),
        } satisfies LawPayProcessingResult
      }

      if (state === 'RESUME') {
        return {
          kind: 'resume',
          paymentId: existing.data.id,
          metadata,
          charge: extractStoredLawPayCharge(metadata)!,
        } satisfies LawPayProcessingResult
      }

      if (state === 'IN_FLIGHT') {
        return { kind: 'busy' } satisfies LawPayProcessingResult
      }

      const nextMetadata = lawPayMetadata(metadata, {
        ...attemptMetadata,
        processing_started_at: nowIso,
        last_error: null,
      })

      const retryUpdate = await admin
        .from('payments')
        .update({
          payment_request_id: paymentRequestId,
          case_id: params.quote.case_id,
          payer_user_id: params.payerUserId,
          amount_cents: params.quote.total_cents,
          currency: 'usd',
          status: 'PROCESSING',
          captured_at: null,
          metadata: nextMetadata,
        })
        .eq('id', existing.data.id)
      if (retryUpdate.error) {
        throw new Error(retryUpdate.error.message)
      }

      return {
        kind: 'acquired',
        paymentId: existing.data.id,
        metadata: nextMetadata,
      } satisfies LawPayProcessingResult
    }

    const insert = await admin
      .from('payments')
      .insert({
        payment_request_id: paymentRequestId,
        case_id: params.quote.case_id,
        payer_user_id: params.payerUserId,
        provider: 'LAWPAY',
        provider_payment_intent_id: paymentKey,
        provider_checkout_session_id: null,
        amount_cents: params.quote.total_cents,
        currency: 'usd',
        status: 'PROCESSING',
        captured_at: null,
        metadata: {
          ...attemptMetadata,
          processing_started_at: nowIso,
        },
      })
      .select('id, metadata')
      .single<{ id: string; metadata: PaymentMetadata | null }>()
    if (!insert.error && insert.data?.id) {
      return {
        kind: 'acquired',
        paymentId: insert.data.id,
        metadata: asPaymentMetadata(insert.data.metadata),
      } satisfies LawPayProcessingResult
    }

    if (insert.error && /duplicate key value|already exists|unique/i.test(insert.error.message)) {
      continue
    }

    throw new Error(insert.error?.message || 'Could not start LawPay charge processing.')
  }
}

async function markLawPayPaymentFailed(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  paymentId: string
  metadata: PaymentMetadata
  error: string
}) {
  const failedUpdate = await params.admin
    .from('payments')
    .update({
      status: 'FAILED',
      metadata: lawPayMetadata(params.metadata, {
        last_error: params.error,
        failed_at: new Date().toISOString(),
      }),
    })
    .eq('id', params.paymentId)

  if (failedUpdate.error) {
    throw new Error(failedUpdate.error.message)
  }
}

async function recordLawPayCharge(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  paymentId: string
  metadata: PaymentMetadata
  charge: StoredLawPayCharge
}) {
  const chargeUpdate = await params.admin
    .from('payments')
    .update({
      amount_cents: params.charge.amountCents,
      currency: 'usd',
      status: 'PROCESSING',
      metadata: lawPayMetadata(params.metadata, {
        provider_charge_id: params.charge.providerChargeId,
        provider_status: params.charge.providerStatus,
        amount_cents: params.charge.amountCents,
        raw: params.charge.raw,
        charged_at: new Date().toISOString(),
        last_error: null,
      }),
    })
    .eq('id', params.paymentId)

  if (chargeUpdate.error) {
    throw new Error(chargeUpdate.error.message)
  }
}

async function ensureLawPayCaseEvent(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  caseId: string
  quoteId: string
  actorId: string
  amountCents: number
  providerChargeId: string
}) {
  const existing = await params.admin
    .from('case_events')
    .select('id')
    .eq('case_id', params.caseId)
    .eq('event_type', 'PAYMENT_SUCCEEDED')
    .contains('metadata', {
      quote_id: params.quoteId,
      provider: 'LAWPAY',
    })
    .maybeSingle<{ id: string }>()

  if (existing.error) {
    throw new Error(existing.error.message)
  }

  if (existing.data?.id) {
    return
  }

  const insert = await params.admin.from('case_events').insert({
    case_id: params.caseId,
    event_type: 'PAYMENT_SUCCEEDED',
    event_summary: 'LawPay checkout payment succeeded.',
    metadata: {
      quote_id: params.quoteId,
      provider: 'LAWPAY',
      provider_charge_id: params.providerChargeId,
      amount_cents: params.amountCents,
    },
    actor_id: params.actorId,
  })

  if (insert.error) {
    throw new Error(insert.error.message)
  }
}

async function finalizeLawPayCharge(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  paymentId: string
  metadata: PaymentMetadata
  quote: QuoteRow
  userId: string
  methodType: LawPayMethodType
  billing: Record<string, unknown>
  charge: StoredLawPayCharge
}) {
  const legacyPayment = await params.admin
    .from('case_payments')
    .upsert(
      {
        quote_id: params.quote.id,
        case_id: params.quote.case_id,
        provider: 'LAWPAY',
        provider_charge_id: params.charge.providerChargeId,
        provider_status: params.charge.providerStatus,
        amount_cents: params.charge.amountCents,
        method_type: params.methodType,
        response_payload: {
          billing: params.billing,
          raw: params.charge.raw,
        },
      },
      { onConflict: 'provider,provider_charge_id' }
    )
  if (legacyPayment.error) {
    throw new Error(legacyPayment.error.message)
  }

  const quoteUpdate = await params.admin
    .from('case_quotes')
    .update({
      status: 'PAID',
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.quote.id)
  if (quoteUpdate.error) {
    throw new Error(quoteUpdate.error.message)
  }

  const ledgerInsert = await params.admin.from('case_financial_ledger').insert({
    case_id: params.quote.case_id,
    entry_type: 'CREDIT',
    amount_cents: params.charge.amountCents,
    currency: 'usd',
    source_table: 'payments',
    source_id: params.paymentId,
    description: 'LawPay payment settled.',
    metadata: {
      quote_id: params.quote.id,
      provider: 'LAWPAY',
      provider_charge_id: params.charge.providerChargeId,
    },
  })
  if (ledgerInsert.error && !/duplicate key value|already exists|unique/i.test(ledgerInsert.error.message)) {
    throw new Error(ledgerInsert.error.message)
  }

  const recalc = await params.admin.rpc('recalculate_case_financials', { p_case_id: params.quote.case_id })
  if (recalc.error) {
    throw new Error(recalc.error.message)
  }

  await markCasePaid(params.quote.case_id)

  await ensureLawPayCaseEvent({
    admin: params.admin,
    caseId: params.quote.case_id,
    quoteId: params.quote.id,
    actorId: params.userId,
    amountCents: params.charge.amountCents,
    providerChargeId: params.charge.providerChargeId,
  })

  const paymentUpdate = await params.admin
    .from('payments')
    .update({
      amount_cents: params.charge.amountCents,
      currency: 'usd',
      status: 'SUCCEEDED',
      captured_at: new Date().toISOString(),
      metadata: lawPayMetadata(params.metadata, {
        quote_id: params.quote.id,
        method_type: params.methodType,
        billing: params.billing,
        provider_charge_id: params.charge.providerChargeId,
        provider_status: params.charge.providerStatus,
        amount_cents: params.charge.amountCents,
        raw: params.charge.raw,
        last_error: null,
        settled_at: new Date().toISOString(),
      }),
    })
    .eq('id', params.paymentId)

  if (paymentUpdate.error) {
    throw new Error(paymentUpdate.error.message)
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json()) as ChargeRequestBody
    const quoteId = String(body.quoteId ?? '').trim()
    const methodTokenId = String(body.methodTokenId ?? '').trim()
    const methodType = body.methodType === 'bank' ? 'bank' : 'card'
    const billing = body.billing ?? {}

    if (!quoteId || !methodTokenId) {
      return NextResponse.json({ ok: false, error: 'quoteId and methodTokenId are required.' }, { status: 400 })
    }

    const quoteRes = await supabase
      .from('case_quotes')
      .select('id, case_id, total_cents, status')
      .eq('id', quoteId)
      .maybeSingle<QuoteRow>()

    if (quoteRes.error || !quoteRes.data) {
      return NextResponse.json({ ok: false, error: 'Quote not found or access denied.' }, { status: 404 })
    }

    const quoteStatus = String(quoteRes.data.status ?? '').trim().toUpperCase()
    if (quoteStatus === 'PAID') {
      return NextResponse.json({ ok: true, duplicate: true })
    }

    if (quoteStatus === 'VOID' || quoteStatus === 'EXPIRED') {
      return NextResponse.json({ ok: false, error: `Quote is ${quoteStatus.toLowerCase()} and cannot be charged.` }, { status: 400 })
    }

    const admin = createServiceRoleClient()
    const processing = await beginLawPayChargeProcessing({
      admin,
      quote: quoteRes.data,
      payerUserId: user.id,
      methodType,
      billing,
    })

    if (processing.kind === 'busy') {
      return NextResponse.json({ ok: false, error: 'Payment is already processing.' }, { status: 409 })
    }

    if (processing.kind === 'duplicate' && quoteStatus === 'PAID') {
      return NextResponse.json({ ok: true, duplicate: true })
    }

    let charge: StoredLawPayCharge
    let metadata = processing.metadata
    if (processing.kind === 'resume') {
      charge = processing.charge
    } else if (processing.kind === 'duplicate') {
      if (!processing.charge) {
        return NextResponse.json(
          { ok: false, error: 'Existing LawPay payment is missing charge details and requires manual review.' },
          { status: 409 }
        )
      }
      charge = processing.charge
    } else {
      const chargeResult = await createLawPayCharge({
        amountCents: Number(quoteRes.data.total_cents),
        methodTokenId,
        methodType,
        idempotencyKey: buildLawPayPaymentKey(quoteRes.data.id),
      })

      if (!chargeResult.ok) {
        await markLawPayPaymentFailed({
          admin,
          paymentId: processing.paymentId,
          metadata,
          error: chargeResult.error,
        })
        return NextResponse.json({ ok: false, error: chargeResult.error }, { status: 400 })
      }

      charge = {
        providerChargeId: String(chargeResult.providerChargeId ?? '').trim(),
        providerStatus: chargeResult.providerStatus,
        amountCents: chargeResult.amountCents,
        raw: chargeResult.raw,
      }

      await recordLawPayCharge({
        admin,
        paymentId: processing.paymentId,
        metadata,
        charge,
      })

      metadata = lawPayMetadata(metadata, {
        provider_charge_id: charge.providerChargeId,
        provider_status: charge.providerStatus,
        amount_cents: charge.amountCents,
        raw: charge.raw,
      })
    }

    const paymentId = processing.paymentId
    await finalizeLawPayCharge({
      admin,
      paymentId,
      metadata,
      quote: quoteRes.data,
      userId: user.id,
      methodType,
      billing,
      charge,
    })

    const completion = await handleQuotePaymentCompletion({
      quoteId: quoteRes.data.id,
      caseId: quoteRes.data.case_id,
    })
    if (!completion.ok) {
      throw new Error(completion.error)
    }

    return NextResponse.json({
      ok: true,
      ...(processing.kind === 'duplicate' ? { duplicate: true } : {}),
      ...(processing.kind === 'resume' ? { recovered: true } : {}),
    })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Charge failed.',
      },
      { status: 500 }
    )
  }
}
