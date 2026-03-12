import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const OCR_PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000

export type OcrPreviewTokenPayload = {
  sub: string
  fileHash: string
  confidence: number
  fields: Record<string, unknown>
  iat: number
  exp: number
}

function base64UrlEncode(input: string) {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function base64UrlDecode(input: string) {
  return Buffer.from(input, 'base64url').toString('utf8')
}

function getPreviewTokenSecret() {
  const candidates = [
    process.env.OCR_PREVIEW_TOKEN_SECRET,
    process.env.AUTH_SECRET,
    process.env.NEXTAUTH_SECRET,
  ]

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) return value
  }

  return ''
}

function signPayload(encodedPayload: string, secret: string) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

export async function hashBrowserFile(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer())
  return createHash('sha256').update(buffer).digest('hex')
}

export function issueOcrPreviewToken(input: {
  userId: string
  fileHash: string
  confidence: number
  fields: Record<string, unknown>
}) {
  const secret = getPreviewTokenSecret()
  if (!secret) return ''

  const issuedAt = Date.now()
  const payload: OcrPreviewTokenPayload = {
    sub: input.userId,
    fileHash: input.fileHash,
    confidence: Number(input.confidence || 0),
    fields: input.fields,
    iat: issuedAt,
    exp: issuedAt + OCR_PREVIEW_TOKEN_TTL_MS,
  }

  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = signPayload(encodedPayload, secret)
  return `${encodedPayload}.${signature}`
}

export function verifyOcrPreviewToken(token: string, expectedUserId: string) {
  const secret = getPreviewTokenSecret()
  if (!secret) {
    return { ok: false as const, message: 'OCR preview token secret is not configured.' }
  }

  const [encodedPayload, providedSignature] = String(token || '').split('.')
  if (!encodedPayload || !providedSignature) {
    return { ok: false as const, message: 'OCR preview token is malformed.' }
  }

  const expectedSignature = signPayload(encodedPayload, secret)
  const providedBuffer = Buffer.from(providedSignature)
  const expectedBuffer = Buffer.from(expectedSignature)
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { ok: false as const, message: 'OCR preview token signature is invalid.' }
  }

  let payload: OcrPreviewTokenPayload
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as OcrPreviewTokenPayload
  } catch {
    return { ok: false as const, message: 'OCR preview token payload is invalid.' }
  }

  if (payload.sub !== expectedUserId) {
    return { ok: false as const, message: 'OCR preview token does not belong to this user.' }
  }

  if (!payload.fileHash || typeof payload.fileHash !== 'string') {
    return { ok: false as const, message: 'OCR preview token is missing file hash.' }
  }

  if (!payload.exp || payload.exp < Date.now()) {
    return { ok: false as const, message: 'OCR preview token has expired.' }
  }

  return {
    ok: true as const,
    payload,
  }
}
