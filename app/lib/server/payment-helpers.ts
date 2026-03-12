const LAWPAY_PROCESSING_BUSY_WINDOW_MS = 2 * 60 * 1000

export type PaymentMetadata = Record<string, unknown>

export type StoredLawPayCharge = {
  providerChargeId: string
  providerStatus: string
  amountCents: number
  raw: unknown
}

export function asPaymentMetadata(value: unknown): PaymentMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return { ...(value as PaymentMetadata) }
}

export function buildLawPayPaymentKey(quoteId: string) {
  return `quote:${quoteId}`
}

export function extractStoredLawPayCharge(metadata: unknown): StoredLawPayCharge | null {
  const record = asPaymentMetadata(metadata)
  const providerChargeId = String(record['provider_charge_id'] ?? '').trim()
  const providerStatus = String(record['provider_status'] ?? '').trim()
  const amountCents = Math.trunc(Number(record['amount_cents'] ?? 0))

  if (!providerChargeId || !providerStatus || !Number.isFinite(amountCents) || amountCents <= 0) {
    return null
  }

  return {
    providerChargeId,
    providerStatus,
    amountCents,
    raw: record['raw'] ?? null,
  }
}

export function classifyLawPayProcessingState(params: {
  status: string | null | undefined
  updatedAt: string | null | undefined
  metadata: unknown
  now?: number
}) {
  const status = String(params.status ?? '').trim().toUpperCase()
  const charge = extractStoredLawPayCharge(params.metadata)
  if (status === 'SUCCEEDED') return 'SUCCEEDED' as const
  if (status === 'PROCESSING' && charge) return 'RESUME' as const

  const updatedAtMs = Date.parse(String(params.updatedAt ?? ''))
  const now = params.now ?? Date.now()
  if (status === 'PROCESSING' && Number.isFinite(updatedAtMs) && now - updatedAtMs < LAWPAY_PROCESSING_BUSY_WINDOW_MS) {
    return 'IN_FLIGHT' as const
  }

  return 'RETRY' as const
}

export function normalizePaymentCurrency(value: unknown) {
  return String(value ?? 'usd').trim().toLowerCase() || 'usd'
}

export function validateStripeSettlement(params: {
  expectedCaseId: string
  expectedAmountCents: number
  expectedCurrency: string
  actualCaseId: string
  actualAmountCents: number
  actualCurrency: string
}) {
  if (params.actualCaseId !== params.expectedCaseId) {
    return 'Stripe checkout case_id does not match the payment request.'
  }

  if (Math.trunc(params.actualAmountCents) !== Math.trunc(params.expectedAmountCents)) {
    return 'Stripe checkout amount does not match the payment request.'
  }

  if (normalizePaymentCurrency(params.actualCurrency) !== normalizePaymentCurrency(params.expectedCurrency)) {
    return 'Stripe checkout currency does not match the payment request.'
  }

  return null
}
