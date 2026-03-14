import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const hasAuthCode =
    request.nextUrl.searchParams.has('code') || request.nextUrl.searchParams.has('token_hash')
  const isCalendarOauthCallback =
    pathname.startsWith('/api/integrations/google-calendar/callback') ||
    pathname.startsWith('/api/integrations/microsoft-calendar/callback')

  // Supabase may fall back to "/?code=..." when redirect URLs are missing.
  // Always route those callbacks through our confirm endpoint.
  if (hasAuthCode && !pathname.startsWith('/auth/confirm') && !isCalendarOauthCallback) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/confirm'
    return NextResponse.redirect(url)
  }

  return NextResponse.next({
    request: { headers: request.headers },
  })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
