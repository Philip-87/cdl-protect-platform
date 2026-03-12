import Link from 'next/link'

export default async function WaitingPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params

  return (
    <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 16px' }}>
      <div style={{ background: '#fff8e1', border: '1px solid #eed38a', borderRadius: 12, padding: 24 }}>
        <h1 style={{ marginTop: 0 }}>Attorney Matching In Progress</h1>
        <p>
          We are requesting a quote from local attorneys who match the court county or are within 50 miles of the court.
        </p>
        <p>
          <strong>Case ID:</strong> {caseId}
        </p>
        <p>
          You can safely close this page. We will email you and update your case dashboard as soon as an attorney submits a fee and payment is ready.
        </p>
        <p style={{ marginBottom: 0 }}>
          <Link href="/dashboard">Back to dashboard</Link>
        </p>
      </div>
    </main>
  )
}
