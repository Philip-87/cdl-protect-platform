import Link from 'next/link'
import { login } from './actions'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; redirectedFrom?: string; email?: string }>
}) {
  const params = await searchParams
  const redirectedFrom = params?.redirectedFrom?.trim() ?? ''
  const prefillEmail = params?.email?.trim() ?? ''
  const signupQuery = new URLSearchParams()
  if (prefillEmail) signupQuery.set('email', prefillEmail)
  if (redirectedFrom) signupQuery.set('redirectedFrom', redirectedFrom)
  const signupHref = signupQuery.toString() ? `/signup?${signupQuery.toString()}` : '/signup'

  return (
    <div className="auth-shell">
      <section className="auth-aside">
        <h2>Traffic Ticket Desk</h2>
        <p>Secure access for case managers, dispatch support, and drivers.</p>
        <ul className="auth-list">
          <li>Ticket intake and status tracking</li>
          <li>Court date and violation visibility</li>
          <li>Document upload and audit timeline</li>
        </ul>
      </section>

      <section className="card auth-card">
        <h1>Sign In</h1>
        <p style={{ marginTop: 0 }}>Access your CDL Protect workspace.</p>

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
              placeholder="you@example.com"
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
          No account yet?{' '}
          <Link href={signupHref} style={{ color: '#143d59', fontWeight: 700 }}>
            Create one
          </Link>
        </p>
        <p style={{ margin: '8px 0 0 0', fontSize: 14 }}>
          Attorney access:{' '}
          <Link href="/attorney/login" style={{ color: '#143d59', fontWeight: 700 }}>
            Open attorney login
          </Link>
        </p>
        <p style={{ margin: '8px 0 0 0', fontSize: 14 }}>
          Admin access:{' '}
          <Link href="/admin/login" style={{ color: '#143d59', fontWeight: 700 }}>
            Open admin login
          </Link>
        </p>
      </section>
    </div>
  )
}
