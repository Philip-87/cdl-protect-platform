import crypto from 'node:crypto'

type StripeEvent = {
  id: string
  type: string
  data?: {
    object?: Record<string, unknown>
  }
}

type HandlerResult =
  | { status: number; body: { ok: true; duplicate?: boolean } }
  | { status: number; body: { ok: false; error: string } }

function parseSignatureHeader(signatureHeader: string) {
  const parts = signatureHeader
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

  let timestamp = ''
  const signatures: string[] = []

  for (const part of parts) {
    const [key, value] = part.split('=')
    if (!key || !value) continue
    if (key === 't') timestamp = value
    if (key === 'v1') signatures.push(value)
  }

  return { timestamp, signatures }
}

export function verifyStripeWebhookSignature(params: {
  payload: string
  signatureHeader: string
  secret: string
  toleranceSeconds?: number
}) {
  const toleranceSeconds = params.toleranceSeconds ?? 5 * 60
  const parsed = parseSignatureHeader(String(params.signatureHeader ?? ''))
  if (!parsed.timestamp || !parsed.signatures.length) return false

  const signedPayload = `${parsed.timestamp}.${params.payload}`
  const expected = crypto.createHmac('sha256', params.secret).update(signedPayload, 'utf8').digest('hex')

  const expectedBuffer = Buffer.from(expected, 'utf8')
  const hasMatch = parsed.signatures.some((sig) => {
    const candidate = Buffer.from(sig, 'utf8')
    if (candidate.length !== expectedBuffer.length) return false
    return crypto.timingSafeEqual(expectedBuffer, candidate)
  })
  if (!hasMatch) return false

  const timestampMs = Number(parsed.timestamp) * 1000
  if (!Number.isFinite(timestampMs)) return false

  const ageSeconds = Math.abs(Date.now() - timestampMs) / 1000
  return ageSeconds <= toleranceSeconds
}

export async function handleStripeWebhookRequest(params: {
  method: string
  rawBody: string
  signatureHeader: string
  webhookSecret: string
  onEvent: (event: StripeEvent, rawBody: string) => Promise<{ duplicate?: boolean }>
}): Promise<HandlerResult> {
  if (params.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Method not allowed.' } }
  }

  if (!params.webhookSecret) {
    return { status: 500, body: { ok: false, error: 'STRIPE_WEBHOOK_SECRET is not configured.' } }
  }

  const isValidSignature = verifyStripeWebhookSignature({
    payload: params.rawBody,
    signatureHeader: params.signatureHeader,
    secret: params.webhookSecret,
  })
  if (!isValidSignature) {
    return { status: 401, body: { ok: false, error: 'Invalid Stripe signature.' } }
  }

  let event: StripeEvent
  try {
    event = JSON.parse(params.rawBody) as StripeEvent
  } catch {
    return { status: 400, body: { ok: false, error: 'Invalid JSON payload.' } }
  }

  if (!event?.id || !event?.type) {
    return { status: 400, body: { ok: false, error: 'Missing Stripe event id/type.' } }
  }

  const result = await params.onEvent(event, params.rawBody)
  return {
    status: 200,
    body: {
      ok: true,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  }
}
