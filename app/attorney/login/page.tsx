import Link from 'next/link'
import { login } from '@/app/login/actions'

export default async function AttorneyLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; redirectedFrom?: string; email?: string }>
}) {
  const params = await searchParams
  const redirectedFrom = params?.redirectedFrom?.trim() || '/attorney/onboarding'
  const prefillEmail = params?.email?.trim() ?? ''

  return (
    <div className="auth-shell">
      <section className="auth-aside">
        <h2>Attorney Access</h2>
        <p>Sign in to review offered cases, update case status, and coordinate with fleets and agencies.</p>
        <ul className="auth-list">
          <li>Offer inbox with accept/decline workflow</li>
          <li>Active case management and deadline tracking</li>
          <li>Closed disposition reporting</li>
        </ul>
      </section>

      <section className="card auth-card">
        <h1>Attorney Sign In</h1>
        <p style={{ marginTop: 0 }}>Attorney accounts are invite-based.</p>

        {redirectedFrom ? (
          <p className="notice">Sign in required to continue to {redirectedFrom}.</p>
        ) : null}
        {params?.message ? <p className="notice">{params.message}</p> : null}

        <form action={login} className="form-grid">
          <input type="hidden" name="redirectedFrom" value={redirectedFrom} />

          <div>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              placeholder="attorney@firm.com"
              defaultValue={prefillEmail}
            />
          </div>

          <div>
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required placeholder="********" />
          </div>

          <button type="submit" className="primary">
            Sign In
          </button>
        </form>

        <p style={{ margin: '14px 0 0 0', fontSize: 14 }}>
          Need an invite? Contact CDL Protect Admin.
        </p>
        <p style={{ margin: '8px 0 0 0', fontSize: 14 }}>
          <Link href="/login" style={{ color: '#143d59', fontWeight: 700 }}>
            Open standard login
          </Link>
        </p>
      </section>
    </div>
  )
}
