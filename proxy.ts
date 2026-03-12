import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isPublicRoute } from '@/app/lib/server/public-route'

function copyResponseCookies(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach((cookie) => {
    to.cookies.set(cookie)
  })
}

function hasSupabaseAuthCookie(request: NextRequest) {
  return request.cookies
    .getAll()
    .some((cookie) => /^sb-.*-auth-token(?:\.\d+)?$/i.test(cookie.name))
}

export { isPublicRoute }

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  })
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
    const redirectResponse = NextResponse.redirect(url)
    copyResponseCookies(response, redirectResponse)
    return redirectResponse
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    console.warn('Supabase environment variables not configured')
    return response
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
          })

          response = NextResponse.next({
            request: { headers: request.headers },
          })

          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  let session = null
  try {
    const { data } = await supabase.auth.getSession()
    session = data.session
  } catch (error) {
    console.error('Error getting session:', error)
  }

  const hasAuthCookie = hasSupabaseAuthCookie(request)

  if (!session && !hasAuthCookie && !isPublicRoute(pathname)) {
    const url = request.nextUrl.clone()
    if (pathname.startsWith('/attorney')) {
      url.pathname = '/attorney/login'
    } else if (pathname.startsWith('/admin')) {
      url.pathname = '/admin/login'
    } else {
      url.pathname = '/login'
    }
    if (pathname !== '/') {
      url.searchParams.set('redirectedFrom', pathname)
    }
    const redirectResponse = NextResponse.redirect(url)
    copyResponseCookies(response, redirectResponse)
    return redirectResponse
  }

  if (
    session &&
    (pathname.startsWith('/login') ||
      pathname.startsWith('/signup') ||
      pathname.startsWith('/attorney/login') ||
      pathname.startsWith('/admin/login'))
  ) {
    const url = request.nextUrl.clone()
    if (pathname.startsWith('/attorney/login')) {
      url.pathname = '/attorney/dashboard'
    } else if (pathname.startsWith('/admin/login')) {
      url.pathname = '/admin/dashboard'
    } else {
      url.pathname = '/dashboard'
    }
    const redirectResponse = NextResponse.redirect(url)
    copyResponseCookies(response, redirectResponse)
    return redirectResponse
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
