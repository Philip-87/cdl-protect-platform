import Link from 'next/link'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { fetchAttorneyCaseOptions, requireAttorneyFeature, requireAttorneyViewer } from '@/app/attorney/lib/server'
import { createAttorneyBillingRequest } from '@/app/attorney/tools/actions'

type PaymentRequestRow = {
  id: string
  case_id: string
  source: string
  amount_cents: number
  currency: string
  status: string
  due_at: string | null
  paid_at: string | null
  created_at: string
  metadata: Record<string, unknown> | null
}

export default async function AttorneyBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
  const viewer = await requireAttorneyViewer()
  requireAttorneyFeature(viewer, 'attorney_billing')
  const { supabase } = viewer
  const cases = await fetchAttorneyCaseOptions(supabase)

  const paymentReqRes = await supabase
    .from('payment_requests')
    .select('id, case_id, source, amount_cents, currency, status, due_at, paid_at, created_at, metadata')
    .order('created_at', { ascending: false })
    .limit(300)

  const paymentRequests = (paymentReqRes.data ?? []) as PaymentRequestRow[]
  const relationMissing = Boolean(paymentReqRes.error && /relation .*payment_requests.* does not exist/i.test(paymentReqRes.error.message))
  const pendingRequests = paymentRequests.filter((item) => !['PAID', 'CANCELLED', 'VOID'].includes(String(item.status).toUpperCase()))
  const paidRequests = paymentRequests.filter((item) => Boolean(item.paid_at))

  return (
    <AttorneyWorkspaceLayout
      active="billing"
      title="Billing"
      description="Track payment requests, checkout links, and unpaid legal work without leaving the matter workspace."
      actions={
        <>
          <Link href="/attorney/integrations" className="button-link secondary">
            LawPay / Stripe
          </Link>
          <Link href="/attorney/dashboard#case-queue" className="button-link secondary">
            Matter queue
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#new-request" className="workspace-subnav-link active">
            Create Request
          </a>
          <a href="#billing-history" className="workspace-subnav-link">
            Requests
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Pending</span>
            <strong>{pendingRequests.length}</strong>
            <span>Open payment requests</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Paid</span>
            <strong>{paidRequests.length}</strong>
            <span>Settled billing items</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Infrastructure</span>
            <strong>{relationMissing ? 'Migration needed' : 'Ready'}</strong>
            <span>{relationMissing ? 'payment_requests missing' : 'Billing tables available'}</span>
          </article>
        </>
      }
    >
        {params?.message ? <p className="notice">{params.message}</p> : null}

        <section className="card" id="new-request">
          <h2 style={{ margin: '0 0 8px 0' }}>Create Payment Request</h2>
          {relationMissing ? (
            <p className="error" style={{ marginBottom: 0 }}>
              Billing tables are missing. Run latest Supabase migrations (including Stripe payments migration).
            </p>
          ) : (
            <form action={createAttorneyBillingRequest} className="intake-grid">
              <input type="hidden" name="return_to" value="/attorney/billing" />
              <div>
                <label htmlFor="billing-case-id">Case</label>
                <select id="billing-case-id" name="case_id" required defaultValue="">
                  <option value="" disabled>
                    Select case
                  </option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} | {c.state} | {c.citation_number ?? '-'}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="billing-source">Request From</label>
                <select id="billing-source" name="source" defaultValue="DIRECT_CLIENT">
                  <option value="DIRECT_CLIENT">Direct Client</option>
                  <option value="CDL_PROTECT">CDL Protect</option>
                </select>
              </div>
              <div>
                <label htmlFor="billing-amount">Amount (USD)</label>
                <input id="billing-amount" name="amount" type="number" min="0.01" step="0.01" required />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input id="billing-checkout" name="create_checkout" type="checkbox" value="1" style={{ width: 'auto' }} />
                <label htmlFor="billing-checkout" style={{ margin: 0 }}>
                  Generate Stripe checkout link (direct client only)
                </label>
              </div>
              <div className="full">
                <label htmlFor="billing-notes">Notes</label>
                <input id="billing-notes" name="notes" placeholder="Include due date, service details, and memo." />
              </div>
              <div style={{ display: 'flex', alignItems: 'end' }}>
                <button type="submit" className="primary">
                  Create Billing Request
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="card" style={{ marginTop: 14 }} id="billing-history">
          <h2 style={{ margin: '0 0 8px 0' }}>Payment Requests</h2>
          {paymentReqRes.error ? (
            <p className="error" style={{ marginBottom: 0 }}>
              {paymentReqRes.error.message}
            </p>
          ) : !paymentRequests.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No payment requests yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #dbd6c8', textAlign: 'left' }}>
                    <th style={{ padding: '10px 8px' }}>Case</th>
                    <th style={{ padding: '10px 8px' }}>Source</th>
                    <th style={{ padding: '10px 8px' }}>Amount</th>
                    <th style={{ padding: '10px 8px' }}>Status</th>
                    <th style={{ padding: '10px 8px' }}>Due</th>
                    <th style={{ padding: '10px 8px' }}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentRequests.map((item) => (
                    <tr key={item.id} style={{ borderBottom: '1px solid #efe8d9' }}>
                      <td style={{ padding: '8px' }}>
                        <Link href={`/cases/${item.case_id}?return_to=${encodeURIComponent('/attorney/billing')}`}>{item.case_id}</Link>
                      </td>
                      <td style={{ padding: '8px' }}>{item.source}</td>
                      <td style={{ padding: '8px' }}>
                        ${(item.amount_cents / 100).toFixed(2)} {item.currency.toUpperCase()}
                      </td>
                      <td style={{ padding: '8px' }}>
                        <span className="badge">{item.status}</span>
                      </td>
                      <td style={{ padding: '8px' }}>{item.due_at ? new Date(item.due_at).toLocaleString() : '-'}</td>
                      <td style={{ padding: '8px' }}>{new Date(item.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
    </AttorneyWorkspaceLayout>
  )
}
