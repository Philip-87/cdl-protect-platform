import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicRoute } from '../app/lib/server/public-route.ts'

test('keeps public webhook and outreach endpoints reachable without auth', () => {
  assert.equal(isPublicRoute('/api/payments/stripe/webhook'), true)
  assert.equal(isPublicRoute('/api/cron/worker'), true)
  assert.equal(isPublicRoute('/api/integrations/google-calendar/callback'), true)
  assert.equal(isPublicRoute('/api/integrations/microsoft-calendar/callback'), true)
  assert.equal(isPublicRoute('/attorney/respond/test-token/accept'), true)
  assert.equal(isPublicRoute('/attorney/respond/test-token/deny'), true)
  assert.equal(isPublicRoute('/dashboard'), false)
})
