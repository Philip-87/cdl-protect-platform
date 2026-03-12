'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/app/lib/supabase/server'

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

export async function setPasswordFromInvite(formData: FormData) {
  const password = String(formData.get('password') ?? '')
  const confirmPassword = String(formData.get('confirm_password') ?? '')
  const redirectedFromRaw = String(formData.get('redirectedFrom') ?? '').trim()
  const redirectedFrom = getSafeRedirectPath(redirectedFromRaw || '/dashboard')

  if (!password || !confirmPassword) {
    redirect(
      `/auth/set-password?message=${encodeURIComponent(
        'Password and confirmation are required.'
      )}&redirectedFrom=${encodeURIComponent(redirectedFrom)}`
    )
  }

  if (password.length < 8) {
    redirect(
      `/auth/set-password?message=${encodeURIComponent(
        'Password must be at least 8 characters.'
      )}&redirectedFrom=${encodeURIComponent(redirectedFrom)}`
    )
  }

  if (password !== confirmPassword) {
    redirect(
      `/auth/set-password?message=${encodeURIComponent(
        'Password and confirmation do not match.'
      )}&redirectedFrom=${encodeURIComponent(redirectedFrom)}`
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    const loginPath = getLoginPathForRedirect(redirectedFrom)
    redirect(
      `${loginPath}?message=${encodeURIComponent(
        'Invite session expired. Please request a new invite.'
      )}&redirectedFrom=${encodeURIComponent(redirectedFrom)}`
    )
  }

  const { error } = await supabase.auth.updateUser({ password })
  if (error) {
    redirect(
      `/auth/set-password?message=${encodeURIComponent(
        `Unable to set password: ${error.message}`
      )}&redirectedFrom=${encodeURIComponent(redirectedFrom)}`
    )
  }

  const email = user.email ?? ''
  await supabase.auth.signOut()

  const loginPath = getLoginPathForRedirect(redirectedFrom)
  const query = new URLSearchParams()
  query.set('message', 'Password set successfully. Sign in to continue.')
  query.set('redirectedFrom', redirectedFrom)
  if (email) query.set('email', email)
  redirect(`${loginPath}?${query.toString()}`)
}
