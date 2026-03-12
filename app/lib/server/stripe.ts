type StripeCheckoutCreateParams = {
  paymentRequestId: string
  caseId: string
  amountCents: number
  currency: string
  description: string
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
}

function normalizeBaseUrl(raw: string) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  try {
    return new URL(value).toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function getAppBaseUrl() {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.SITE_URL,
    process.env.APP_URL,
  ]

  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(String(candidate ?? ''))
    if (normalized) return normalized
  }

  const vercelUrl = String(process.env.NEXT_PUBLIC_VERCEL_URL ?? process.env.VERCEL_URL ?? '').trim()
  if (vercelUrl) {
    const prefixed = vercelUrl.startsWith('http') ? vercelUrl : `https://${vercelUrl}`
    const normalized = normalizeBaseUrl(prefixed)
    if (normalized) return normalized
  }

  if (process.env.NODE_ENV !== 'production') {
    return 'http://localhost:3000'
  }

  return null
}

export function isStripeConfigured() {
  return String(process.env.STRIPE_SECRET_KEY ?? '').trim().length > 0
}

export async function createStripeCheckoutSession(params: StripeCheckoutCreateParams): Promise<
  | { ok: true; id: string; url: string | null }
  | { ok: false; error: string }
> {
  const secretKey = String(process.env.STRIPE_SECRET_KEY ?? '').trim()
  if (!secretKey) {
    return { ok: false, error: 'Stripe is not configured.' }
  }

  const currency = String(params.currency || 'usd').trim().toLowerCase() || 'usd'
  const amountCents = Math.max(1, Math.trunc(params.amountCents))
  const form = new URLSearchParams()

  form.set('mode', 'payment')
  form.set('success_url', params.successUrl)
  form.set('cancel_url', params.cancelUrl)
  form.set('line_items[0][quantity]', '1')
  form.set('line_items[0][price_data][currency]', currency)
  form.set('line_items[0][price_data][unit_amount]', String(amountCents))
  form.set('line_items[0][price_data][product_data][name]', params.description)
  form.set('metadata[payment_request_id]', params.paymentRequestId)
  form.set('metadata[case_id]', params.caseId)

  if (params.customerEmail) {
    form.set('customer_email', params.customerEmail)
  }

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `payment-request-${params.paymentRequestId}`,
    },
    body: form.toString(),
    cache: 'no-store',
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || typeof payload !== 'object') {
    const message =
      (payload && typeof payload === 'object' && typeof payload['error'] === 'object'
        ? String((payload['error'] as Record<string, unknown>)['message'] ?? '')
        : '') || `Stripe checkout request failed (${response.status}).`
    return { ok: false, error: message }
  }

  return {
    ok: true,
    id: String((payload as Record<string, unknown>)['id'] ?? ''),
    url: (payload as Record<string, unknown>)['url'] ? String((payload as Record<string, unknown>)['url']) : null,
  }
}
