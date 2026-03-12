import { redirect } from 'next/navigation'
import { createClient } from '@/app/lib/supabase/server'
import { setPasswordFromInvite } from './actions'

function getSafeRedirectPath(rawPath: string) {
  if (!rawPath.startsWith('/')) return '/dashboard'
  if (rawPath.startsWith('//')) return '/dashboard'
  return rawPath
}

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; redirectedFrom?: string }>
}) {
  const params = await searchParams
  const redirectedFrom = getSafeRedirectPath(String(params?.redirectedFrom ?? '/dashboard'))
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect(
      `/login?message=${encodeURIComponent(
        'Invite session expired. Please request a new invite.'
      )}&redirectedFrom=${encodeURIComponent(redirectedFrom)}`
    )
  }

  return (
    <div className="auth-shell">
      <section className="auth-aside">
        <h2>Set Your Password</h2>
        <p>Finish account activation by creating your password.</p>
      </section>

      <section className="card auth-card">
        <h1>Create Password</h1>
        <p style={{ marginTop: 0 }}>You will be redirected to sign in after saving your password.</p>

        {params?.message ? <p className="notice">{params.message}</p> : null}

        <form action={setPasswordFromInvite} className="form-grid">
          <input type="hidden" name="redirectedFrom" value={redirectedFrom} />

          <div>
            <label htmlFor="password">New password</label>
            <input id="password" name="password" type="password" required minLength={8} />
          </div>

          <div>
            <label htmlFor="confirm_password">Confirm password</label>
            <input id="confirm_password" name="confirm_password" type="password" required minLength={8} />
          </div>

          <button type="submit" className="primary">
            Save Password
          </button>
        </form>
      </section>
    </div>
  )
}
