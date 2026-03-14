import Link from 'next/link'
import { redirect } from 'next/navigation'
import AuthLoginForm from '@/app/components/AuthLoginForm'
import { login } from '@/app/login/actions'
import { getAuthenticatedLandingPath } from '@/app/lib/server/auth-landing'
import { getServerAuthUser } from '@/app/lib/supabase/auth-user'
import { createClient } from '@/app/lib/supabase/server'

export default async function AttorneyLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; redirectedFrom?: string; email?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const user = await getServerAuthUser(supabase)
  if (user) {
    redirect(await getAuthenticatedLandingPath(supabase, user.id))
  }

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

        <AuthLoginForm
          action={login}
          redirectedFrom={redirectedFrom}
          prefillEmail={prefillEmail}
          emailPlaceholder="attorney@firm.com"
        />

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
