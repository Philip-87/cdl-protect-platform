import Link from 'next/link'

export default function Home() {
  return (
    <div style={{ padding: '24px 0 36px' }}>
      <section className="card hero-card">
        <p className="hero-eyebrow">CDL TICKET OPERATIONS</p>
        <h1 className="hero-title">Handle citations, court deadlines, and documents in one workflow.</h1>
        <p className="hero-subtitle">
          CDL Protect keeps your team aligned from intake through resolution with secure driver
          access, status controls, and activity history.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <Link href="/login" className="button-link primary">
            Sign In
          </Link>
          <Link href="/signup" className="button-link secondary">
            Create Account
          </Link>
        </div>
      </section>

      <section className="grid-2" style={{ marginTop: 18 }}>
        <article className="card">
          <h2 style={{ margin: '0 0 10px 0' }}>Workflow Steps</h2>
          <ol style={{ margin: 0, paddingLeft: 18, color: '#5e6068', display: 'grid', gap: 7 }}>
            <li>Intake citation details from driver or dispatcher.</li>
            <li>Track case progression through required legal milestones.</li>
            <li>Upload court files and supporting documents per case.</li>
            <li>Review timeline activity and final resolution status.</li>
          </ol>
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 10px 0' }}>Built For Reliability</h2>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#5e6068', display: 'grid', gap: 7 }}>
            <li>Supabase-backed authentication and protected routes.</li>
            <li>Role-aware policies for case and document access.</li>
            <li>Status pipeline from intake through attorney assignment and closure.</li>
            <li>Case activity audit trail for accountability.</li>
          </ul>
        </article>
      </section>
    </div>
  )
}
