import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PlatformRole } from '@/app/lib/roles'

function getBaseUrl() {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.SITE_URL,
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_VERCEL_URL,
    process.env.VERCEL_URL,
    process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null,
  ]

  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim()
    if (!raw) continue

    let normalized = raw
    if (!/^https?:\/\//i.test(normalized)) {
      const isLocalHost = /^localhost(?::\d+)?$/i.test(normalized) || /^127\.0\.0\.1(?::\d+)?$/.test(normalized)
      normalized = `${isLocalHost ? 'http' : 'https'}://${normalized}`
    }

    try {
      return new URL(normalized).toString()
    } catch {
      continue
    }
  }

  return null
}

function getInviteRedirectPath(targetRole: PlatformRole) {
  if (targetRole === 'ATTORNEY') {
    return '/auth/confirm?next=/attorney/onboarding&set_password=1'
  }

  if (targetRole === 'ADMIN' || targetRole === 'OPS' || targetRole === 'AGENT') {
    return '/auth/confirm?next=/admin/dashboard&set_password=1'
  }

  return '/auth/confirm?next=/dashboard&set_password=1'
}

function getInviteEmailHint(message: string) {
  if (/database error saving new user/i.test(message)) {
    return 'Invite created, but Supabase failed creating the auth user. Run the latest profile trigger migration and retry. User can still sign up with the invited email.'
  }

  if (/signups not allowed|signup is disabled/i.test(message)) {
    return 'Invite created, but direct user creation is disabled in Supabase Auth. Enable email signups or configure service-role invite flow.'
  }

  if (/email rate limit exceeded/i.test(message)) {
    return 'Invite created, but email was rate-limited by Supabase. User can still sign up with the invited email.'
  }

  if (/error sending confirmation email/i.test(message) || /smtp/i.test(message)) {
    return 'Invite created, but SMTP/email provider is not configured correctly in Supabase Auth. User can still sign up with the invited email.'
  }

  return `Invite created, but email dispatch failed: ${message}. User can still sign up with the invited email.`
}

function getServiceRoleClient() {
  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!supabaseUrl || !serviceRoleKey) return null

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

function getAnonOtpClient() {
  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anonKey = String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!supabaseUrl || !anonKey) return null

  return createSupabaseClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      flowType: 'implicit',
    },
  })
}

function isExistingUserError(message: string) {
  return /already (registered|exists|been registered)|email exists|user already exists/i.test(message)
}

function getManualActivationPath(email: string, targetRole: PlatformRole) {
  const basePath =
    targetRole === 'ATTORNEY'
      ? '/attorney/onboarding'
      : targetRole === 'ADMIN' || targetRole === 'OPS' || targetRole === 'AGENT'
      ? '/admin/dashboard'
      : '/dashboard'

  const query = new URLSearchParams()
  query.set('email', email)
  query.set('redirectedFrom', basePath)
  return `/signup?${query.toString()}`
}

export async function sendAuthInviteEmail(
  supabase: SupabaseClient,
  email: string,
  targetRole: PlatformRole
) {
  const baseUrl = getBaseUrl()
  const redirectPath = getInviteRedirectPath(targetRole)
  const emailRedirectTo = baseUrl ? new URL(redirectPath, baseUrl).toString() : undefined
  const adminClient = getServiceRoleClient()
  const otpClient = getAnonOtpClient() ?? supabase

  if (adminClient) {
    const { error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      redirectTo: emailRedirectTo,
    })

    if (!error) {
      return {
        sent: true as const,
        notice: 'Invitation email sent.',
      }
    }

    if (isExistingUserError(error.message)) {
      const existingUserSignIn = await otpClient.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo,
        },
      })

      if (!existingUserSignIn.error) {
        return {
          sent: true as const,
          notice: 'User already exists; sign-in email sent.',
        }
      }
    }

    const manualActivationPath = getManualActivationPath(email, targetRole)
    return {
      sent: false as const,
      notice: `${getInviteEmailHint(error.message)} Manual activation path: ${manualActivationPath}`,
    }
  }

  const { error } = await otpClient.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo,
    },
  })

  if (error) {
    const manualActivationPath = getManualActivationPath(email, targetRole)
    return {
      sent: false as const,
      notice: `${getInviteEmailHint(error.message)} Manual activation path: ${manualActivationPath}`,
    }
  }

  return {
    sent: true as const,
    notice: 'Invitation email sent.',
  }
}
