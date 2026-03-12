'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/app/lib/supabase/server'
import { claimRoleInvitesSafe } from '@/app/lib/server/claim-invites'
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

function mapSignUpError(message: string) {
  if (/user already registered/i.test(message)) {
    return 'This email is already registered. Try signing in instead.'
  }

  if (/password should be at least/i.test(message)) {
    return 'Password is too short. Use at least 6 characters.'
  }

  return message
}

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

function getLoginPathForRedirect(redirectedFrom: string) {
  if (redirectedFrom.startsWith('/attorney/')) return '/attorney/login'
  if (redirectedFrom.startsWith('/admin/')) return '/admin/login'
  return '/login'
}

export async function signup(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const requestedRoleRaw = String(formData.get('requestedRole') ?? 'DRIVER')
    .trim()
    .toUpperCase()
  const requestedRole =
    requestedRoleRaw === 'AGENCY' || requestedRoleRaw === 'FLEET' || requestedRoleRaw === 'DRIVER'
      ? requestedRoleRaw
      : 'DRIVER'
  const redirectedFrom = String(formData.get('redirectedFrom') ?? '').trim()
  const safeRedirectPath = getSafeRedirectPath(redirectedFrom || '/dashboard')
  const loginPath = getLoginPathForRedirect(safeRedirectPath)

  if (!email || !password) {
    redirect('/signup?message=Email%20and%20password%20are%20required.')
  }

  let supabase: Awaited<ReturnType<typeof createClient>>
  try {
    supabase = await createClient()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supabase is not configured.'
    redirect(`/signup?message=${encodeURIComponent(message)}`)
  }

  const baseUrl = getBaseUrl()
  const emailRedirectTo = baseUrl
    ? new URL(
        `/auth/confirm?next=${encodeURIComponent(safeRedirectPath)}&set_password=0`,
        baseUrl
      ).toString()
    : undefined

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: email, requested_role: requestedRole },
      emailRedirectTo,
    },
  })

  if (error) {
    redirect(
      `/signup?message=${encodeURIComponent(mapSignUpError(error.message))}&email=${encodeURIComponent(
        email
      )}&redirectedFrom=${encodeURIComponent(safeRedirectPath)}`
    )
  }

  if (!data.session) {
    redirect(
      `${loginPath}?message=${encodeURIComponent(
        'Check your email to confirm your account, then sign in.'
      )}&email=${encodeURIComponent(
        email
      )}&redirectedFrom=${encodeURIComponent(safeRedirectPath)}`
    )
  }

  if (data.user) {
    await syncProfileRoleFromMetadata(data.user)
  }
  await claimRoleInvitesSafe()
  revalidatePath('/', 'layout')

  redirect(safeRedirectPath)
}
