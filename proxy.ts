import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const supabaseKey = String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

  if (supabaseUrl && supabaseKey) {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
            response.cookies.set(name, value, options)
          })
        },
      },
    })

    // Refresh auth cookies so server-rendered routes see the same session as the browser.
    await supabase.auth.getUser()
  }

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

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
