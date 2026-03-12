export function isPublicRoute(pathname: string) {
  return (
    pathname === '/' ||
    pathname.startsWith('/api/auth/login') ||
    pathname.startsWith('/api/auth/session') ||
    pathname.startsWith('/auth/confirm') ||
    pathname.startsWith('/auth/set-password') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/signup') ||
    pathname.startsWith('/attorney/login') ||
    pathname.startsWith('/admin/login') ||
    pathname.startsWith('/attorney/respond/') ||
    pathname.startsWith('/api/integrations/google-calendar/callback') ||
    pathname.startsWith('/api/integrations/microsoft-calendar/callback') ||
    pathname.startsWith('/api/cron/worker') ||
    pathname.startsWith('/api/payments/stripe/webhook')
  )
}
