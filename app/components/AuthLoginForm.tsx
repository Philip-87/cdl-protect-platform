function getSafeRedirectPath(rawPath: string) {
  if (!rawPath.startsWith('/')) {
    return '/dashboard'
  }

  if (rawPath.startsWith('//')) {
    return '/dashboard'
  }

  return rawPath
}

export default function AuthLoginForm({
  action,
  redirectedFrom,
  prefillEmail = '',
  emailPlaceholder,
}: {
  action: (formData: FormData) => void | Promise<void>
  redirectedFrom: string
  prefillEmail?: string
  emailPlaceholder: string
}) {
  return (
    <form action={action} className="form-grid">
      <input type="hidden" name="redirectedFrom" value={getSafeRedirectPath(redirectedFrom || '/dashboard')} />

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
        />
      </div>

      <button type="submit" className="primary">
        Sign In
      </button>
    </form>
  )
}
