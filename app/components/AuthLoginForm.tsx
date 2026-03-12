'use client'

import type { FormEvent } from 'react'
import { useState, useTransition } from 'react'
import { createClient } from '@/app/lib/supabase/client'

function getSafeRedirectPath(rawPath: string) {
  if (!rawPath.startsWith('/')) {
    return '/dashboard'
  }

  if (rawPath.startsWith('//')) {
    return '/dashboard'
  }

  return rawPath
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

export default function AuthLoginForm({
  redirectedFrom,
  prefillEmail = '',
  emailPlaceholder,
}: {
  redirectedFrom: string
  prefillEmail?: string
  emailPlaceholder: string
}) {
  const [message, setMessage] = useState('')
  const [isPending, startTransition] = useTransition()

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const email = String(formData.get('email') ?? '').trim()
    const password = String(formData.get('password') ?? '')
    const target = getSafeRedirectPath(redirectedFrom || '/dashboard')

    if (!email || !password) {
      setMessage('Email and password are required.')
      return
    }

    setMessage('')

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setMessage(mapSignInError(error.message))
      return
    }

    window.location.assign(target)
  }

  return (
    <form
      onSubmit={(event) => {
        startTransition(() => {
          void handleSubmit(event)
        })
      }}
      className="form-grid"
    >
      <input type="hidden" name="redirectedFrom" value={redirectedFrom} />

      <div>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          placeholder={emailPlaceholder}
          autoComplete="email"
          defaultValue={prefillEmail}
          disabled={isPending}
        />
      </div>

      <div>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          placeholder="********"
          autoComplete="current-password"
          defaultValue=""
          disabled={isPending}
        />
      </div>

      {message ? <p className="notice">{message}</p> : null}

      <button type="submit" className="primary" disabled={isPending}>
        {isPending ? 'Signing In...' : 'Sign In'}
      </button>
    </form>
  )
}
