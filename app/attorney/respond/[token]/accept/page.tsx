import { redirect } from 'next/navigation'
import { acceptPricedOutreach, getOutreachTokenSummary, submitOutreachQuote } from '@/app/lib/matching/attorneyMatching'

async function acceptAction(formData: FormData) {
  'use server'

  const token = String(formData.get('token') ?? '').trim()
  const outreachType = String(formData.get('outreach_type') ?? '').trim().toUpperCase()
  const notes = String(formData.get('notes') ?? '').trim()

  if (!token) {
    redirect('/attorney/login?message=Invalid%20outreach%20token.')
  }

  const result =
    outreachType === 'PRICED_MATCH'
      ? await acceptPricedOutreach({
          rawToken: token,
        })
      : await submitOutreachQuote({
          rawToken: token,
          feeCents: Math.round(Number(String(formData.get('fee_dollars') ?? '').trim()) * 100),
          notes,
        })

  if (!result.ok) {
    redirect(`/attorney/respond/${encodeURIComponent(token)}/accept?error=${encodeURIComponent(String(result.error ?? 'Request failed.'))}`)
  }

  redirect(
    `/attorney/respond/${encodeURIComponent(token)}/accept?success=1&case=${encodeURIComponent(result.caseId)}&kind=${encodeURIComponent(
      outreachType === 'PRICED_MATCH' ? 'priced' : 'quote'
    )}`
  )
}

export default async function AttorneyAcceptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string; success?: string; case?: string; kind?: string }>
}) {
  const { token } = await params
  const query = await searchParams

  const summary = await getOutreachTokenSummary(token)
  const error = query.error ? decodeURIComponent(query.error) : ''
  const success = query.success === '1'
  const successKind = String(query.kind ?? '').trim().toLowerCase()

  return (
    <main style={{ maxWidth: 820, margin: '32px auto', padding: '0 16px' }}>
      <div style={{ background: '#f8fafc', border: '1px solid #d0d7de', borderRadius: 12, padding: 24 }}>
        <h1 style={{ marginTop: 0 }}>
          {summary.ok && summary.outreach.outreach_type === 'PRICED_MATCH' ? 'Confirm Assignment' : 'Submit Attorney Quote'}
        </h1>

        {error ? (
          <p style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, padding: 10 }}>{error}</p>
        ) : null}

        {success ? (
          <p style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 8, padding: 10 }}>
            {successKind === 'priced' ? 'Assignment confirmed. Thank you.' : 'Quote submitted successfully. Thank you.'}
          </p>
        ) : null}

        {!summary.ok ? (
          <p style={{ background: '#fff8e1', border: '1px solid #eed38a', borderRadius: 8, padding: 10 }}>{summary.error}</p>
        ) : (
          <>
            <ul>
              <li>
                <strong>Workflow:</strong> {summary.outreach.outreach_type === 'PRICED_MATCH' ? 'Priced assignment' : 'Quote request'}
              </li>
              <li>
                <strong>State:</strong> {summary.caseSummary.state ?? '-'}
              </li>
              <li>
                <strong>County:</strong> {summary.caseSummary.county ?? '-'}
              </li>
              <li>
                <strong>Citation:</strong> {summary.caseSummary.citation_number ?? '-'}
              </li>
              <li>
                <strong>Violation:</strong> {summary.caseSummary.violation_code ?? '-'}
              </li>
              <li>
                <strong>Court:</strong> {summary.caseSummary.court_name ?? summary.caseSummary.court_address ?? '-'}
              </li>
              <li>
                <strong>Court Date:</strong> {summary.caseSummary.court_date ?? '-'} {summary.caseSummary.court_time ?? ''}
              </li>
            </ul>

            {summary.documents.length ? (
              <div style={{ marginTop: 16 }}>
                <h2 style={{ fontSize: 18, marginBottom: 8 }}>Ticket Files</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {summary.documents.map((doc) => (
                    <li key={doc.id}>
                      <a href={doc.signedUrl} target="_blank" rel="noreferrer">
                        {doc.filename}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {!success && !summary.handled ? (
              summary.outreach.outreach_type === 'PRICED_MATCH' ? (
                <form action={acceptAction} style={{ marginTop: 20, display: 'grid', gap: 12, maxWidth: 360 }}>
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="outreach_type" value={summary.outreach.outreach_type} />
                  <button type="submit" style={{ padding: '10px 14px', borderRadius: 8, border: 0, background: '#1f4b76', color: '#fff' }}>
                    Confirm Assignment
                  </button>
                </form>
              ) : (
                <form action={acceptAction} style={{ marginTop: 20, display: 'grid', gap: 12, maxWidth: 520 }}>
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="outreach_type" value={summary.outreach.outreach_type} />
                  <label htmlFor="fee_dollars">Attorney Fee (USD)</label>
                  <input id="fee_dollars" name="fee_dollars" type="number" min="1" step="0.01" required />
                  <label htmlFor="notes">Notes (optional)</label>
                  <textarea id="notes" name="notes" rows={4} placeholder="Optional scope or court notes." />
                  <button type="submit" style={{ padding: '10px 14px', borderRadius: 8, border: 0, background: '#1f4b76', color: '#fff' }}>
                    Submit Quote
                  </button>
                </form>
              )
            ) : null}
          </>
        )}
      </div>
    </main>
  )
}
