import test from 'node:test'
import assert from 'node:assert/strict'
import {
  asPaymentMetadata,
  buildLawPayPaymentKey,
  classifyLawPayProcessingState,
  extractStoredLawPayCharge,
  normalizePaymentCurrency,
  validateStripeSettlement,
} from '../app/lib/server/payment-helpers.ts'

test('LawPay payment keys are stable per quote', () => {
  assert.equal(buildLawPayPaymentKey('quote-123'), 'quote:quote-123')
})

test('LawPay processing state stays busy for a recent in-flight attempt', () => {
  const now = Date.now()
  const state = classifyLawPayProcessingState({
    status: 'PROCESSING',
    updatedAt: new Date(now - 30 * 1000).toISOString(),
    metadata: {},
    now,
  })

  assert.equal(state, 'IN_FLIGHT')
})

test('LawPay processing resumes finalization when a stored provider charge exists', () => {
  const metadata = {
    provider_charge_id: 'charge-123',
    provider_status: 'captured',
    amount_cents: 25000,
    raw: { id: 'charge-123' },
  }

  assert.deepEqual(extractStoredLawPayCharge(metadata), {
    providerChargeId: 'charge-123',
    providerStatus: 'captured',
    amountCents: 25000,
    raw: { id: 'charge-123' },
  })

  const state = classifyLawPayProcessingState({
    status: 'PROCESSING',
    updatedAt: new Date().toISOString(),
    metadata,
  })

  assert.equal(state, 'RESUME')
})

test('Stripe settlement validation rejects amount and currency mismatches', () => {
  assert.equal(
    validateStripeSettlement({
      expectedCaseId: 'case-1',
      expectedAmountCents: 15000,
      expectedCurrency: 'usd',
      actualCaseId: 'case-1',
      actualAmountCents: 15000,
      actualCurrency: 'USD',
    }),
    null
  )

  assert.match(
    validateStripeSettlement({
      expectedCaseId: 'case-1',
      expectedAmountCents: 15000,
      expectedCurrency: 'usd',
      actualCaseId: 'case-1',
      actualAmountCents: 14999,
      actualCurrency: 'usd',
    }) || '',
    /amount/i
  )

  assert.match(
    validateStripeSettlement({
      expectedCaseId: 'case-1',
      expectedAmountCents: 15000,
      expectedCurrency: 'usd',
      actualCaseId: 'case-1',
      actualAmountCents: 15000,
      actualCurrency: 'cad',
    }) || '',
    /currency/i
  )
})

test('payment metadata helpers normalize plain objects only', () => {
  assert.deepEqual(asPaymentMetadata(null), {})
  assert.deepEqual(asPaymentMetadata(['nope']), {})
  assert.equal(normalizePaymentCurrency('USD'), 'usd')
})
