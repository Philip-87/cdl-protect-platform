'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/app/lib/supabase/server'
import { claimRoleInvitesSafe } from '@/app/lib/server/claim-invites'
import { writePlatformLog } from '@/app/lib/server/platform-logs'
import { syncProfileRoleFromMetadata } from '@/app/lib/server/profile-role-sync'

function getSafeRedirectPath(rawPath: string) {
  if (!rawPath.startsWith('/')) {
    return '/dashboard'
  }

  if (rawPath.startsWith('//')) {
    return '/dashboard'
  }

  return rawPath
}

function getLoginPathForRedirect(redirectedFrom: string) {
  if (redirectedFrom.startsWith('/attorney/')) {
    return '/attorney/login'
  }

  if (redirectedFrom.startsWith('/admin/')) {
    return '/admin/login'
  }

  return '/login'
}

function buildLoginRedirect(path: string, message: string, redirectedFrom: string) {
  const query = new URLSearchParams()
  query.set('message', message)
  if (redirectedFrom) query.set('redirectedFrom', getSafeRedirectPath(redirectedFrom))
  return `${path}?${query.toString()}`
}

function mapSignInError(message: string) {
  if (/email not confirmed/i.test(message)) {
    return 'Email not confirmed. Check your inbox and confirm the account first.'
  }

  if (/invalid login credentials/i.test(message)) {
    return 'Invalid email or password.'
  }

  return message
}

export async function login(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const redirectedFrom = String(formData.get('redirectedFrom') ?? '').trim()
  const loginPath = getLoginPathForRedirect(redirectedFrom)

  if (!email || !password) {
    await writePlatformLog({
      severity: 'WARN',
      eventType: 'LOGIN_REJECTED',
      source: 'auth.login',
      message: 'Login rejected due to missing credentials.',
      metadata: { email },
      requestPath: loginPath,
    })
    redirect(buildLoginRedirect(loginPath, 'Email and password are required.', redirectedFrom))
  }

  let supabase: Awaited<ReturnType<typeof createClient>>
  try {
    supabase = await createClient()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supabase is not configured.'
    await writePlatformLog({
      severity: 'ERROR',
      eventType: 'LOGIN_CONFIG_ERROR',
      source: 'auth.login',
      message,
      metadata: { email },
      requestPath: loginPath,
    })
    redirect(buildLoginRedirect(loginPath, message, redirectedFrom))
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    await writePlatformLog({
      severity: 'WARN',
      eventType: 'LOGIN_FAILED',
      source: 'auth.login',
      message: mapSignInError(error.message),
      metadata: { email },
      requestPath: loginPath,
    })
    redirect(buildLoginRedirect(loginPath, mapSignInError(error.message), redirectedFrom))
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) {
    await syncProfileRoleFromMetadata(user)
    await writePlatformLog({
      severity: 'INFO',
      eventType: 'LOGIN_SUCCEEDED',
      source: 'auth.login',
      message: 'User signed in successfully.',
      actorUserId: user.id,
      metadata: { email: user.email ?? email },
      requestPath: loginPath,
    })
  }

  await claimRoleInvitesSafe()

  redirect(getSafeRedirectPath(redirectedFrom || '/dashboard'))
}
