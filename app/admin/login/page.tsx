import Link from 'next/link'
import { login } from '@/app/login/actions'

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; redirectedFrom?: string }>
}) {
  const params = await searchParams
  const redirectedFrom = params?.redirectedFrom?.trim() || '/admin/dashboard'

  return (
    <div className="auth-shell">
      <section className="auth-aside">
        <h2>Admin Access</h2>
        <p>Sign in to manage tenant accounts, monitor operational health, and run bulk imports.</p>
        <ul className="auth-list">
          <li>Platform-wide case and assignment visibility</li>
          <li>Attorney onboarding and invite management</li>
          <li>CSV imports for firms, contacts, and cases</li>
        </ul>
      </section>

      <section className="card auth-card">
        <h1>Admin Sign In</h1>
        <p style={{ marginTop: 0 }}>Restricted to staff roles (ADMIN, OPS, AGENT).</p>

        {redirectedFrom ? (
          <p className="notice">Sign in required to continue to {redirectedFrom}.</p>
        ) : null}
        {params?.message ? <p className="notice">{params.message}</p> : null}

        <form action={login} className="form-grid">
          <input type="hidden" name="redirectedFrom" value={redirectedFrom} />

          <div>
            <label htmlFor="email">Email address</label>
            <input id="email" name="email" type="email" required placeholder="admin@cdlprotect.com" />
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
          Need access? Contact your platform owner.
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
