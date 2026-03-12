import { sendEmail } from '@/app/lib/server/email'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'

export type QuotePaymentSourceType = 'DIRECT_PRICED' | 'ATTORNEY_QUOTE' | 'MANUAL_MATCH' | 'DIRECT_REQUEST'

type MetadataRecord = Record<string, unknown>

function isSchemaIssue(message: string | null | undefined) {
  const text = String(message ?? '')
  return /does not exist|schema cache|could not find the/i.test(text)
}

function getMissingColumnName(message: string | null | undefined) {
  const text = String(message ?? '')
  const patterns = [
    /column\s+((?:"?[a-zA-Z0-9_]+"?\.)*"?[a-zA-Z0-9_]+"?)\s+does not exist/i,
    /could not find the '([a-zA-Z0-9_]+)' column/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const candidate = match[1].replace(/"/g, '').split('.').pop()?.trim()
      if (candidate) return candidate
    }
  }

  return null
}

function mergeMetadata(base: unknown, patch: MetadataRecord) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return { ...patch }
  }

  return {
    ...(base as MetadataRecord),
    ...patch,
  }
}

export function formatUsdCents(value: number | null | undefined) {
  const cents = Number(value ?? 0)
  const normalized = Number.isFinite(cents) ? cents : 0
  return `$${(normalized / 100).toFixed(2)}`
}

function metadataMatchesQuoteId(metadata: MetadataRecord | null | undefined, quoteId: string) {
  return String(metadata?.['quote_id'] ?? '').trim() === String(quoteId ?? '').trim()
}

type PaymentRequestLookupRow = {
  id: string
  metadata: MetadataRecord | null
  created_at?: string | null
}

async function findLatestPaymentRequestRecord(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  caseId: string
  quoteId: string
}) {
  const direct = await params.admin
    .from('payment_requests')
    .select('id, metadata, created_at')
    .eq('quote_id', params.quoteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<PaymentRequestLookupRow>()

  if (!direct.error) {
    return { ok: true as const, data: direct.data ?? null }
  }

  if (!isSchemaIssue(direct.error.message)) {
    return { ok: false as const, error: direct.error.message }
  }

  const fallback = await params.admin
    .from('payment_requests')
    .select('id, metadata, created_at')
    .eq('case_id', params.caseId)
    .order('created_at', { ascending: false })
    .limit(8)

  if (fallback.error) {
    return { ok: false as const, error: fallback.error.message }
  }

  const rows = (fallback.data ?? []) as PaymentRequestLookupRow[]
  const match = rows.find((row) => metadataMatchesQuoteId(row.metadata, params.quoteId)) ?? rows[0] ?? null
  return { ok: true as const, data: match }
}

async function updatePaymentRequestSafe(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  paymentRequestId: string
  payload: Record<string, unknown>
}) {
  const payload = { ...params.payload }

  while (Object.keys(payload).length) {
    const update = await params.admin.from('payment_requests').update(payload).eq('id', params.paymentRequestId)
    if (!update.error) {
      return { ok: true as const }
    }

    if (!isSchemaIssue(update.error.message)) {
      return { ok: false as const, error: update.error.message }
    }

    const missingColumn = getMissingColumnName(update.error.message)
    if (missingColumn && missingColumn in payload) {
      delete payload[missingColumn]
      continue
    }

    return { ok: false as const, error: update.error.message }
  }

  return { ok: true as const }
}

async function insertPaymentRequestSafe(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  payload: Record<string, unknown>
}) {
  const payload = { ...params.payload }

  while (Object.keys(payload).length) {
    const insert = await params.admin.from('payment_requests').insert(payload).select('id').single<{ id: string }>()
    if (!insert.error && insert.data?.id) {
      return { ok: true as const, id: insert.data.id }
    }

    if (!insert.error) {
      return { ok: false as const, error: 'Could not create payment request.' }
    }

    if (!isSchemaIssue(insert.error.message)) {
      return { ok: false as const, error: insert.error.message }
    }

    const missingColumn = getMissingColumnName(insert.error.message)
    if (missingColumn && missingColumn in payload) {
      delete payload[missingColumn]
      continue
    }

    return { ok: false as const, error: insert.error.message }
  }

  return { ok: false as const, error: 'Could not create payment request.' }
}

export async function findLatestPaymentRequestIdForQuoteSafe(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  caseId: string
  quoteId: string
}) {
  const existing = await findLatestPaymentRequestRecord(params)
  if (!existing.ok) return existing
  return {
    ok: true as const,
    paymentRequestId: existing.data?.id ?? null,
  }
}

export async function createInAppCaseNotification(params: {
  userId: string | null | undefined
  caseId: string
  category: string
  title: string
  body: string
  href?: string | null
  metadata?: MetadataRecord
}) {
  const userId = String(params.userId ?? '').trim()
  if (!userId) {
    return { ok: true as const, skipped: true as const }
  }

  const admin = createServiceRoleClient()
  const insert = await admin.from('in_app_notifications').insert({
    user_id: userId,
    case_id: params.caseId,
    category: params.category,
    title: params.title,
    body: params.body,
    href: params.href ?? null,
    delivered_at: new Date().toISOString(),
    metadata: params.metadata ?? {},
  })

  if (insert.error) {
    if (isSchemaIssue(insert.error.message)) {
      return { ok: true as const, skipped: true as const }
    }

    return { ok: false as const, error: insert.error.message }
  }

  return { ok: true as const }
}

export async function upsertQuotePaymentRequest(params: {
  caseId: string
  quoteId: string
  amountCents: number
  requestedByUserId: string | null | undefined
  requestedToUserId?: string | null | undefined
  requestEmail?: string | null | undefined
  payerRole: string
  sourceType: QuotePaymentSourceType
  checkoutUrl?: string | null
  note?: string | null
  notificationTitle?: string | null
  notificationBody?: string | null
  notificationHref?: string | null
  emailSubject?: string | null
  emailHtml?: string | null
  emailText?: string | null
  metadata?: MetadataRecord
  sendEmail?: boolean
}) {
  const requestedByUserId = String(params.requestedByUserId ?? params.requestedToUserId ?? '').trim()
  if (!requestedByUserId) {
    return { ok: false as const, error: 'A request owner is required to create a payment request.' }
  }

  const requestEmail = String(params.requestEmail ?? '').trim().toLowerCase()
  const requestedToUserId = String(params.requestedToUserId ?? '').trim() || null
  const admin = createServiceRoleClient()
  const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const sentAt = new Date().toISOString()
  const baseMetadata = {
    quote_id: params.quoteId,
    checkout_url: params.checkoutUrl ?? null,
    note: params.note ?? null,
    source_type: params.sourceType,
    request_email: requestEmail || null,
    ...params.metadata,
  }

  const existing = await findLatestPaymentRequestRecord({
    admin,
    caseId: params.caseId,
    quoteId: params.quoteId,
  })

  if (!existing.ok) {
    return { ok: false as const, error: existing.error }
  }

  let paymentRequestId = existing.data?.id ?? ''
  if (paymentRequestId) {
    const update = await updatePaymentRequestSafe({
      admin,
      paymentRequestId,
      payload: {
        requested_by: requestedByUserId,
        requested_to_user_id: requestedToUserId,
        request_email: requestEmail || null,
        payer_role: params.payerRole,
        source: 'DIRECT_CLIENT',
        source_type: params.sourceType,
        amount_cents: params.amountCents,
        currency: 'usd',
        status: 'OPEN',
        due_at: dueAt,
        quote_id: params.quoteId,
        sent_at: sentAt,
        metadata: mergeMetadata(existing.data?.metadata, baseMetadata),
        updated_at: sentAt,
      },
    })

    if (!update.ok) {
      return { ok: false as const, error: update.error }
    }
  } else {
    const insert = await insertPaymentRequestSafe({
      admin,
      payload: {
        case_id: params.caseId,
        quote_id: params.quoteId,
        requested_by: requestedByUserId,
        requested_to_user_id: requestedToUserId,
        request_email: requestEmail || null,
        payer_role: params.payerRole,
        source: 'DIRECT_CLIENT',
        source_type: params.sourceType,
        amount_cents: params.amountCents,
        currency: 'usd',
        status: 'OPEN',
        due_at: dueAt,
        sent_at: sentAt,
        metadata: baseMetadata,
      },
    })

    if (!insert.ok || !insert.id) {
      return { ok: false as const, error: insert.error || 'Could not create payment request.' }
    }

    paymentRequestId = insert.id
  }

  const notificationTitle = String(params.notificationTitle ?? '').trim()
  const notificationBody = String(params.notificationBody ?? '').trim()
  if (requestedToUserId && notificationTitle && notificationBody) {
    await createInAppCaseNotification({
      userId: requestedToUserId,
      caseId: params.caseId,
      category: 'PAYMENT_REQUEST',
      title: notificationTitle,
      body: notificationBody,
      href: params.notificationHref ?? `/cases/${params.caseId}`,
      metadata: {
        payment_request_id: paymentRequestId,
        ...baseMetadata,
      },
    })
  }

  if (params.sendEmail && requestEmail && params.emailSubject && params.emailHtml) {
    const delivery = await sendEmail({
      to: [{ email: requestEmail }],
      subject: params.emailSubject,
      html: params.emailHtml,
      text: params.emailText ?? undefined,
    })

    if (!delivery.ok) {
      return { ok: false as const, error: delivery.error }
    }
  }

  return {
    ok: true as const,
    paymentRequestId,
  }
}

export async function markQuotePaymentRequestPaid(params: {
  quoteId: string
  caseId?: string | null
  provider: string
  providerCheckoutSessionId?: string | null
  providerPaymentIntentId?: string | null
  metadata?: MetadataRecord
}) {
  const admin = createServiceRoleClient()
  const existing = await findLatestPaymentRequestRecord({
    admin,
    caseId: String(params.caseId ?? '').trim(),
    quoteId: params.quoteId,
  })

  if (!existing.ok) {
    return { ok: false as const, error: existing.error }
  }

  if (!existing.data?.id) {
    return { ok: true as const, skipped: true as const }
  }

  const paidAt = new Date().toISOString()
  const update = await updatePaymentRequestSafe({
    admin,
    paymentRequestId: existing.data.id,
    payload: {
      status: 'PAID',
      paid_at: paidAt,
      provider: params.provider,
      provider_checkout_session_id: params.providerCheckoutSessionId ?? null,
      provider_payment_intent_id: params.providerPaymentIntentId ?? null,
      metadata: mergeMetadata(existing.data?.metadata, {
        paid_at: paidAt,
        provider: params.provider,
        ...params.metadata,
      }),
      updated_at: paidAt,
    },
  })

  if (!update.ok) {
    return { ok: false as const, error: update.error }
  }

  return {
    ok: true as const,
    paymentRequestId: existing.data.id,
  }
}
