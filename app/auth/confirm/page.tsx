'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/supabase/client'

function getSafeRedirectPath(rawPath: string) {
  if (!rawPath.startsWith('/')) return '/dashboard'
  if (rawPath.startsWith('//')) return '/dashboard'
  return rawPath
}

function getLoginPathForRedirect(redirectedFrom: string) {
  if (redirectedFrom.startsWith('/attorney/')) return '/attorney/login'
  if (redirectedFrom.startsWith('/admin/')) return '/admin/login'
  return '/login'
}

function getFailureRedirect(loginPath: string, redirectedFrom: string, message: string) {
  const query = new URLSearchParams()
  query.set('message', message)
  query.set('redirectedFrom', redirectedFrom)
  return `${loginPath}?${query.toString()}`
}

type ConfirmState =
  | { status: 'loading'; message: string }
  | { status: 'error'; message: string; href: string; hrefLabel: string }

export default function AuthConfirmPage() {
  const router = useRouter()
  const [state, setState] = useState<ConfirmState>({
    status: 'loading',
    message: 'Confirming your link...',
  })

  useEffect(() => {
    let cancelled = false

    async function completeAuthFlow() {
      const query = new URLSearchParams(window.location.search)
      const nextParam = String(query.get('next') ?? '').trim()
      const redirectedFromParam = String(query.get('redirectedFrom') ?? '').trim()
      const redirectedFrom = getSafeRedirectPath(nextParam || redirectedFromParam || '/dashboard')
      const loginPath = getLoginPathForRedirect(redirectedFrom)

      const type = String(query.get('type') ?? '').trim().toLowerCase()
      const setPasswordFlag = String(query.get('set_password') ?? '')
        .trim()
        .toLowerCase()
      const shouldForceSetPassword = setPasswordFlag === '1' || setPasswordFlag === 'true'

      const code = String(query.get('code') ?? '').trim()
      const tokenHash = String(query.get('token_hash') ?? '').trim()

      const hashRaw = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash
      const hash = new URLSearchParams(hashRaw)
      const accessToken = String(hash.get('access_token') ?? '').trim()
      const refreshToken = String(hash.get('refresh_token') ?? '').trim()
      const hashType = String(hash.get('type') ?? '').trim().toLowerCase()
      const hashError =
        String(hash.get('error_description') ?? '').trim() || String(hash.get('error') ?? '').trim()

      const supabase = createClient()

      let handledAuthToken = false
      const shouldSetPassword =
        shouldForceSetPassword || type === 'invite' || type === 'recovery' || hashType === 'invite' || hashType === 'recovery'

      if (code) {
        handledAuthToken = true
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) {
          router.replace(
            getFailureRedirect(loginPath, redirectedFrom, `Email confirmation failed: ${error.message}`)
          )
          return
        }
      } else if (tokenHash && type) {
        handledAuthToken = true
        const { error } = await supabase.auth.verifyOtp({
          type: type as
            | 'signup'
            | 'invite'
            | 'magiclink'
            | 'recovery'
            | 'email_change'
            | 'email',
          token_hash: tokenHash,
        })

        if (error) {
          router.replace(
            getFailureRedirect(loginPath, redirectedFrom, `Email confirmation failed: ${error.message}`)
          )
          return
        }
      } else if (accessToken && refreshToken) {
        handledAuthToken = true
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })

        if (error) {
          router.replace(
            getFailureRedirect(loginPath, redirectedFrom, `Email confirmation failed: ${error.message}`)
          )
          return
        }
      }

      if (!handledAuthToken && hashError) {
        router.replace(getFailureRedirect(loginPath, redirectedFrom, `Email confirmation failed: ${hashError}`))
        return
      }

      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        router.replace(
          getFailureRedirect(
            loginPath,
            redirectedFrom,
            handledAuthToken
              ? 'Invite session expired. Please request a new invite.'
              : 'Confirmation link is missing required parameters.'
          )
        )
        return
      }

      if (shouldSetPassword) {
        router.replace(`/auth/set-password?redirectedFrom=${encodeURIComponent(redirectedFrom)}`)
        return
      }

      await supabase.auth.signOut()
      const loginQuery = new URLSearchParams()
      loginQuery.set('message', 'Email confirmed. Sign in to continue.')
      loginQuery.set('redirectedFrom', redirectedFrom)
      if (user.email) loginQuery.set('email', user.email)
      router.replace(`${loginPath}?${loginQuery.toString()}`)
    }

    completeAuthFlow().catch((error) => {
      if (cancelled) return

      const query = new URLSearchParams(window.location.search)
      const nextParam = String(query.get('next') ?? '').trim()
      const redirectedFromParam = String(query.get('redirectedFrom') ?? '').trim()
      const redirectedFrom = getSafeRedirectPath(nextParam || redirectedFromParam || '/dashboard')
      const loginPath = getLoginPathForRedirect(redirectedFrom)
      const message =
        error instanceof Error ? error.message : 'Unexpected confirmation error. Please request a new invite.'

      setState({
        status: 'error',
        message,
        href: `${loginPath}?redirectedFrom=${encodeURIComponent(redirectedFrom)}`,
        hrefLabel: 'Back to sign in',
      })
    })

    return () => {
      cancelled = true
    }
  }, [router])

  if (state.status === 'error') {
    return (
      <div className="auth-shell">
        <section className="card auth-card">
          <h1>Confirmation Error</h1>
          <p className="notice">{state.message}</p>
          <p style={{ marginTop: 12 }}>
            <Link href={state.href} style={{ color: '#143d59', fontWeight: 700 }}>
              {state.hrefLabel}
            </Link>
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="auth-shell">
      <section className="card auth-card">
        <h1>Confirming Access</h1>
        <p style={{ marginTop: 0 }}>{state.message}</p>
      </section>
    </div>
  )
}
