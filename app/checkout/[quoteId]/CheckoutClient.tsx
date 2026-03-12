'use client'

import { useEffect, useMemo, useState } from 'react'

type CheckoutClientProps = {
  quoteId: string
  caseId: string
  caseReference: string
  totalCents: number
  attorneyFeeCents: number
  platformFeeCents: number
  paymentFlowStatus?: string | null
  primaryContactType?: string | null
  paymentRequestStatus?: string | null
  paymentRequestSourceType?: string | null
  paymentDueAt?: string | null
  quoteSource?: string | null
  lawPayAccountId: string
}

declare global {
  interface Window {
    AffiniPay?: {
      HostedFields?: {
        initializeFields: (options: Record<string, unknown>) => Promise<{
          getPaymentToken: (params?: Record<string, unknown>) => Promise<{ id?: string }>
        }>
      }
    }
  }
}

const scriptId = 'lawpay-hosted-fields-script'
const scriptSrc = 'https://cdn.affinipay.com/hostedfields/1.5.3/fieldGen_1.5.3.js'

function formatFlowLabel(value: string | null | undefined) {
  const raw = String(value ?? '').trim().toUpperCase()
  if (!raw) return '-'
  return raw
    .split('_')
    .map((chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase())
    .join(' ')
}

function formatDateTime(value: string | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!raw) return '-'
  const parsed = new Date(raw)
  if (Number.isNaN(+parsed)) return raw
  return parsed.toLocaleString()
}

export default function CheckoutClient(props: CheckoutClientProps) {
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [methodType, setMethodType] = useState<'card' | 'bank'>('card')
  const [hostedFields, setHostedFields] = useState<null | {
    getPaymentToken: (params?: Record<string, unknown>) => Promise<{ id?: string }>
  }>(null)

  const [billingName, setBillingName] = useState('')
  const [billingEmail, setBillingEmail] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [expMonth, setExpMonth] = useState('')
  const [expYear, setExpYear] = useState('')

  const [accountHolderType, setAccountHolderType] = useState<'individual' | 'business'>('individual')
  const [achName, setAchName] = useState('')
  const [accountType, setAccountType] = useState<'checking' | 'savings'>('checking')

  const totalDollars = useMemo(() => (props.totalCents / 100).toFixed(2), [props.totalCents])

  useEffect(() => {
    let mounted = true

    const mount = async () => {
      setError('')
      setReady(false)

      if (!props.lawPayAccountId) {
        setError('LawPay account id is missing. Configure LAW_PAY_ACCOUNT_ID.')
        return
      }

      if (!document.getElementById(scriptId)) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script')
          script.id = scriptId
          script.src = scriptSrc
          script.async = true
          script.onload = () => resolve()
          script.onerror = () => reject(new Error('Failed to load LawPay hosted fields script.'))
          document.body.appendChild(script)
        })
      }

      if (!window.AffiniPay?.HostedFields?.initializeFields) {
        setError('LawPay hosted fields are unavailable.')
        return
      }

      const fieldConfig =
        methodType === 'card'
          ? {
              cardNumber: { selector: '#hf-card-number' },
              cardCode: { selector: '#hf-card-code' },
            }
          : {
              routingNumber: { selector: '#hf-routing-number' },
              accountNumber: { selector: '#hf-account-number' },
            }

      const instance = await window.AffiniPay.HostedFields.initializeFields({
        publicKey: props.lawPayAccountId,
        fields: fieldConfig,
      })

      if (!mounted) return
      setHostedFields(instance)
      setReady(true)
    }

    mount().catch((mountError) => {
      setError(mountError instanceof Error ? mountError.message : 'Failed to initialize checkout fields.')
    })

    return () => {
      mounted = false
    }
  }, [methodType, props.lawPayAccountId])

  const submitPayment = async () => {
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      if (!hostedFields) {
        throw new Error('Payment fields are not ready yet.')
      }

      const token = await hostedFields.getPaymentToken(
        methodType === 'card'
          ? {
              paymentMethod: 'card',
              exp_month: expMonth,
              exp_year: expYear,
              postal_code: postalCode,
              name: billingName,
              email: billingEmail,
            }
          : {
              paymentMethod: 'bank',
              account_holder_type: accountHolderType,
              account_type: accountType,
              name: achName,
            }
      )

      const tokenId = String(token?.id ?? '').trim()
      if (!tokenId) {
        throw new Error('LawPay tokenization failed. Please verify card/bank fields.')
      }

      const response = await fetch('/api/lawpay/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: props.quoteId,
          methodType,
          methodTokenId: tokenId,
          billing: {
            name: billingName,
            email: billingEmail,
            postalCode,
            expMonth,
            expYear,
            achName,
            accountHolderType,
            accountType,
          },
        }),
      })

      const payload = (await response.json()) as {
        ok: boolean
        error?: string
      }

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Payment failed.')
      }

      setSuccess('Payment successful. Your case is now marked as paid.')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Payment failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section style={{ background: '#f8fafc', border: '1px solid #d0d7de', borderRadius: 12, padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>Quote Summary</h2>
        <p>Case Reference: {props.caseReference}</p>
        <p>Attorney Fee: ${(props.attorneyFeeCents / 100).toFixed(2)}</p>
        <p>Platform Fee: ${(props.platformFeeCents / 100).toFixed(2)}</p>
        <p>
          <strong>Total: ${totalDollars}</strong>
        </p>
        <p>Workflow: {formatFlowLabel(props.paymentFlowStatus)}</p>
        <p>Payment Request: {formatFlowLabel(props.paymentRequestStatus)}</p>
        <p>Source: {formatFlowLabel(props.paymentRequestSourceType || props.quoteSource)}</p>
        <p>Primary Contact: {formatFlowLabel(props.primaryContactType)}</p>
        {props.paymentDueAt ? <p>Due: {formatDateTime(props.paymentDueAt)}</p> : null}
      </section>

      <section style={{ background: '#fff', border: '1px solid #d0d7de', borderRadius: 12, padding: 16, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 12 }}>
          <label>
            <input
              type="radio"
              checked={methodType === 'card'}
              onChange={() => setMethodType('card')}
              disabled={loading}
            />{' '}
            Credit Card
          </label>
          <label>
            <input
              type="radio"
              checked={methodType === 'bank'}
              onChange={() => setMethodType('bank')}
              disabled={loading}
            />{' '}
            eCheck / ACH
          </label>
        </div>

        {methodType === 'card' ? (
          <>
            <label>
              Name
              <input value={billingName} onChange={(event) => setBillingName(event.target.value)} />
            </label>
            <label>
              Email
              <input value={billingEmail} onChange={(event) => setBillingEmail(event.target.value)} type="email" />
            </label>
            <label>
              Postal code
              <input value={postalCode} onChange={(event) => setPostalCode(event.target.value)} />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label>
                Exp month
                <input value={expMonth} onChange={(event) => setExpMonth(event.target.value)} placeholder="MM" />
              </label>
              <label>
                Exp year
                <input value={expYear} onChange={(event) => setExpYear(event.target.value)} placeholder="YYYY" />
              </label>
            </div>
            <label>
              Card number
              <div id="hf-card-number" style={{ minHeight: 40, border: '1px solid #cbd5e1', borderRadius: 8, padding: 8 }} />
            </label>
            <label>
              CVV
              <div id="hf-card-code" style={{ minHeight: 40, border: '1px solid #cbd5e1', borderRadius: 8, padding: 8 }} />
            </label>
          </>
        ) : (
          <>
            <p style={{ margin: 0, padding: 8, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8 }}>
              By submitting this payment, you authorize ACH debit for the amount shown above.
            </p>
            <label>
              Account holder type
              <select value={accountHolderType} onChange={(event) => setAccountHolderType(event.target.value as 'individual' | 'business')}>
                <option value="individual">Individual</option>
                <option value="business">Business</option>
              </select>
            </label>
            <label>
              Name
              <input value={achName} onChange={(event) => setAchName(event.target.value)} />
            </label>
            <label>
              Account type
              <select value={accountType} onChange={(event) => setAccountType(event.target.value as 'checking' | 'savings')}>
                <option value="checking">Checking</option>
                <option value="savings">Savings</option>
              </select>
            </label>
            <label>
              Routing number
              <div id="hf-routing-number" style={{ minHeight: 40, border: '1px solid #cbd5e1', borderRadius: 8, padding: 8 }} />
            </label>
            <label>
              Account number
              <div id="hf-account-number" style={{ minHeight: 40, border: '1px solid #cbd5e1', borderRadius: 8, padding: 8 }} />
            </label>
          </>
        )}

        {error ? <p style={{ color: '#b91c1c', margin: 0 }}>{error}</p> : null}
        {success ? <p style={{ color: '#166534', margin: 0 }}>{success}</p> : null}
        {success ? (
          <a href={`/cases/${encodeURIComponent(props.caseId)}`} style={{ color: '#0f4c81', fontWeight: 600 }}>
            Return to case
          </a>
        ) : null}

        <button
          type="button"
          disabled={!ready || loading}
          onClick={submitPayment}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            border: 0,
            background: '#1f4b76',
            color: '#fff',
            cursor: !ready || loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Processing...' : `Pay $${totalDollars}`}
        </button>
      </section>
    </div>
  )
}
