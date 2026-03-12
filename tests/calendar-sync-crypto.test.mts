import test from 'node:test'
import assert from 'node:assert/strict'
import { decryptCalendarSecret, encryptCalendarSecret, issueCalendarOauthState, verifyCalendarOauthState } from '../app/lib/server/calendar-sync-crypto.ts'

test('calendar sync crypto encrypts and decrypts provider secrets', () => {
  process.env.CALENDAR_SYNC_SECRET = 'calendar-sync-test-secret'
  const encrypted = encryptCalendarSecret({ token: 'abc123', refresh: 'def456' })
  const decrypted = decryptCalendarSecret<{ token: string; refresh: string }>(encrypted)

  assert.equal(decrypted.token, 'abc123')
  assert.equal(decrypted.refresh, 'def456')
})

test('calendar oauth state round-trips signed payloads', () => {
  process.env.CALENDAR_SYNC_SECRET = 'calendar-sync-test-secret'
  const token = issueCalendarOauthState({
    userId: 'user-1',
    provider: 'GOOGLE',
    returnTo: '/attorney/integrations',
  })

  const verified = verifyCalendarOauthState(token)
  if (!verified.ok) {
    assert.fail(verified.message)
  }

  assert.equal(verified.payload.sub, 'user-1')
  assert.equal(verified.payload.provider, 'GOOGLE')
  assert.equal(verified.payload.returnTo, '/attorney/integrations')
})

test('calendar crypto requires a dedicated secret and will not reuse cron credentials', () => {
  const previousCalendarSecret = process.env.CALENDAR_SYNC_SECRET
  const previousOauthSecret = process.env.OAUTH_STATE_SECRET
  const previousAuthSecret = process.env.AUTH_SECRET
  const previousNextAuthSecret = process.env.NEXTAUTH_SECRET
  const previousCronSecret = process.env.CRON_SECRET
  const previousServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  delete process.env.CALENDAR_SYNC_SECRET
  delete process.env.OAUTH_STATE_SECRET
  delete process.env.AUTH_SECRET
  delete process.env.NEXTAUTH_SECRET
  process.env.CRON_SECRET = 'cron-secret-only'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-only'

  try {
    assert.throws(() => encryptCalendarSecret({ token: 'abc123' }), /CALENDAR_SYNC_SECRET is not configured/i)

    const verified = verifyCalendarOauthState('missing.signature')
    assert.equal(verified.ok, false)
    if (verified.ok) return
    assert.match(verified.message, /CALENDAR_SYNC_SECRET is not configured/i)
  } finally {
    if (previousCalendarSecret === undefined) delete process.env.CALENDAR_SYNC_SECRET
    else process.env.CALENDAR_SYNC_SECRET = previousCalendarSecret
    if (previousOauthSecret === undefined) delete process.env.OAUTH_STATE_SECRET
    else process.env.OAUTH_STATE_SECRET = previousOauthSecret
    if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = previousAuthSecret
    if (previousNextAuthSecret === undefined) delete process.env.NEXTAUTH_SECRET
    else process.env.NEXTAUTH_SECRET = previousNextAuthSecret
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previousCronSecret
    if (previousServiceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceRoleKey
  }
})
