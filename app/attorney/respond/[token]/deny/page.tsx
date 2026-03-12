import { redirect } from 'next/navigation'
import { denyOutreach, getOutreachTokenSummary } from '@/app/lib/matching/attorneyMatching'

async function denyAction(formData: FormData) {
  'use server'

  const token = String(formData.get('token') ?? '').trim()
  const reason = String(formData.get('reason') ?? '').trim()

  const result = await denyOutreach({
    rawToken: token,
    reason,
  })

  if (!result.ok) {
    redirect(`/attorney/respond/${encodeURIComponent(token)}/deny?error=${encodeURIComponent(String(result.error ?? 'Request failed.'))}`)
  }

  redirect(`/attorney/respond/${encodeURIComponent(token)}/deny?success=1`)
}

export default async function AttorneyDenyPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string; success?: string }>
}) {
  const { token } = await params
  const query = await searchParams

  const summary = await getOutreachTokenSummary(token)
  const error = query.error ? decodeURIComponent(query.error) : ''
  const success = query.success === '1'

  return (
    <main style={{ maxWidth: 820, margin: '32px auto', padding: '0 16px' }}>
      <div style={{ background: '#f8fafc', border: '1px solid #d0d7de', borderRadius: 12, padding: 24 }}>
        <h1 style={{ marginTop: 0 }}>Decline Case Outreach</h1>

        {error ? (
          <p style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, padding: 10 }}>{error}</p>
        ) : null}

        {success ? (
          <p style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 8, padding: 10 }}>
            Your decline response was recorded.
          </p>
        ) : null}

        {!summary.ok ? (
          <p style={{ background: '#fff8e1', border: '1px solid #eed38a', borderRadius: 8, padding: 10 }}>{summary.error}</p>
        ) : (
          <>
            <p>
              <strong>Case:</strong> {summary.caseSummary.state ?? '-'} / {summary.caseSummary.county ?? '-'} /{' '}
              {summary.caseSummary.citation_number ?? '-'}
            </p>
            <p>
              <strong>Workflow:</strong> {summary.outreach.outreach_type === 'PRICED_MATCH' ? 'Priced assignment' : 'Quote request'}
            </p>
            {!success && !summary.handled ? (
              <form action={denyAction} style={{ marginTop: 20, display: 'grid', gap: 12, maxWidth: 520 }}>
                <input type="hidden" name="token" value={token} />
                <label htmlFor="reason">Reason for decline</label>
                <textarea id="reason" name="reason" rows={4} required />
                <button type="submit" style={{ padding: '10px 14px', borderRadius: 8, border: 0, background: '#991b1b', color: '#fff' }}>
                  Submit Decline
                </button>
              </form>
            ) : null}
          </>
        )}
      </div>
    </main>
  )
}
