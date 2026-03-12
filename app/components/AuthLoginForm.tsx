'use client'

import { useState } from 'react'

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
  const [email, setEmail] = useState(prefillEmail)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const nextEmail = email.trim()
    if (!nextEmail || !password) {
      setError('Email and password are required.')
      return
    }

    setSubmitting(true)
    setError('')

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          email: nextEmail,
          password,
          redirectedFrom,
        }),
        credentials: 'same-origin',
      })

      const contentType = String(response.headers.get('content-type') ?? '')
      if (!/application\/json/i.test(contentType)) {
        const text = await response.text()
        const summary = response.redirected
          ? `Login request redirected to ${response.url}`
          : `Login endpoint returned ${response.status} ${response.statusText || 'response'}`
        setError(`${summary}. ${text.slice(0, 120)}`.trim())
        setSubmitting(false)
        return
      }

      const result = (await response.json()) as { ok?: boolean; error?: string; redirectTo?: string }

      if (!response.ok || !result.ok) {
        setError(mapSignInError(String(result.error ?? 'Unable to sign in right now.')))
        setSubmitting(false)
        return
      }

      const redirectTarget = result.redirectTo ?? redirectedFrom ?? '/dashboard'
      window.location.assign(getSafeRedirectPath(String(redirectTarget)))
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to sign in right now.')
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="form-grid">
      <div>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          placeholder={emailPlaceholder}
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
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
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
        />
      </div>

      {error ? <p className="notice">{error}</p> : null}

      <button type="submit" className="primary" disabled={submitting}>
        {submitting ? 'Signing In...' : 'Sign In'}
      </button>
    </form>
  )
}
