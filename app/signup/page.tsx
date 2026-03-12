import Link from 'next/link'
import { signup } from './actions'

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; email?: string; redirectedFrom?: string }>
}) {
  const params = await searchParams
  const prefillEmail = params?.email?.trim() ?? ''
  const redirectedFrom = params?.redirectedFrom?.trim() ?? ''

  return (
    <div className="auth-shell">
      <section className="auth-aside">
        <h2>Create Team Access</h2>
        <p>Set up your account to begin processing traffic-ticket cases.</p>
        <ul className="auth-list">
          <li>Protected dashboard and case operations</li>
          <li>Role-aware case visibility</li>
          <li>Secure document storage in Supabase</li>
          <li>Attorney accounts are invite-only from Admin/Agency workflows</li>
        </ul>
      </section>

      <section className="card auth-card">
        <h1>Create Account</h1>
        <p style={{ marginTop: 0 }}>
          Start using CDL Protect with your business email. Attorney access is provisioned by invite.
        </p>

        {params?.message ? <p className="notice">{params.message}</p> : null}

        <form action={signup} className="form-grid">
          <input type="hidden" name="redirectedFrom" value={redirectedFrom} />
          <div>
            <label>Account type</label>
            <div className="auth-toggle" role="radiogroup" aria-label="Account type">
              <label className="auth-toggle-option">
                <input type="radio" name="requestedRole" value="AGENCY" />
                <span>Create Agency Account</span>
              </label>
              <label className="auth-toggle-option">
                <input type="radio" name="requestedRole" value="DRIVER" defaultChecked />
                <span>Create Driver Account</span>
              </label>
              <label className="auth-toggle-option">
                <input type="radio" name="requestedRole" value="FLEET" />
                <span>Create Fleet Account</span>
              </label>
            </div>
          </div>

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
            Create Account
          </button>
        </form>

        <p style={{ margin: '14px 0 0 0', fontSize: 14 }}>
          Already registered?{' '}
          <Link href="/login" style={{ color: '#143d59', fontWeight: 700 }}>
            Sign in
          </Link>
        </p>
      </section>
    </div>
  )
}
