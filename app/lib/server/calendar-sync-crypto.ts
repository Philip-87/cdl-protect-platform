import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const STATE_TTL_MS = 15 * 60 * 1000

type CalendarOauthStatePayload = {
  sub: string
  provider: 'GOOGLE' | 'MICROSOFT'
  returnTo: string
  iat: number
  exp: number
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function getCalendarSyncSecret() {
  const candidates = [
    process.env.CALENDAR_SYNC_SECRET,
    process.env.OAUTH_STATE_SECRET,
    process.env.AUTH_SECRET,
    process.env.NEXTAUTH_SECRET,
  ]

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) return value
  }

  return ''
}

function getKeyMaterial(secret: string) {
  return createHash('sha256').update(secret).digest()
}

function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function encryptCalendarSecret(payload: Record<string, unknown>) {
  const secret = getCalendarSyncSecret()
  if (!secret) {
    throw new Error('CALENDAR_SYNC_SECRET is not configured.')
  }

  const iv = randomBytes(12)
  const key = getKeyMaterial(secret)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${authTag.toString('base64url')}`
}

export function decryptCalendarSecret<T>(token: string): T {
  const secret = getCalendarSyncSecret()
  if (!secret) {
    throw new Error('CALENDAR_SYNC_SECRET is not configured.')
  }

  const [ivPart, encryptedPart, tagPart] = String(token ?? '').split('.')
  if (!ivPart || !encryptedPart || !tagPart) {
    throw new Error('Encrypted calendar secret is malformed.')
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    getKeyMaterial(secret),
    Buffer.from(ivPart, 'base64url')
  )
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8')

  return JSON.parse(decrypted) as T
}

export function issueCalendarOauthState(input: {
  userId: string
  provider: 'GOOGLE' | 'MICROSOFT'
  returnTo: string
}) {
  const secret = getCalendarSyncSecret()
  if (!secret) {
    throw new Error('CALENDAR_SYNC_SECRET is not configured.')
  }

  const issuedAt = Date.now()
  const payload: CalendarOauthStatePayload = {
    sub: input.userId,
    provider: input.provider,
    returnTo: input.returnTo.startsWith('/') ? input.returnTo : '/attorney/integrations',
    iat: issuedAt,
    exp: issuedAt + STATE_TTL_MS,
  }

  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = sign(encodedPayload, secret)
  return `${encodedPayload}.${signature}`
}

export function verifyCalendarOauthState(token: string) {
  const secret = getCalendarSyncSecret()
  if (!secret) {
    return { ok: false as const, message: 'CALENDAR_SYNC_SECRET is not configured.' }
  }

  const [encodedPayload, providedSignature] = String(token ?? '').split('.')
  if (!encodedPayload || !providedSignature) {
    return { ok: false as const, message: 'OAuth state token is malformed.' }
  }

  const expected = sign(encodedPayload, secret)
  const providedBuffer = Buffer.from(providedSignature)
  const expectedBuffer = Buffer.from(expected)
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { ok: false as const, message: 'OAuth state token signature is invalid.' }
  }

  let payload: CalendarOauthStatePayload
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as CalendarOauthStatePayload
  } catch {
    return { ok: false as const, message: 'OAuth state payload is invalid.' }
  }

  if (!payload.sub || !payload.provider) {
    return { ok: false as const, message: 'OAuth state payload is incomplete.' }
  }

  if (payload.exp < Date.now()) {
    return { ok: false as const, message: 'OAuth state token has expired.' }
  }

  return { ok: true as const, payload }
}
