import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

type LoginPayload = {
  email: string
  password: string
  redirectedFrom: string
}

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

function getLoginPathForRedirect(redirectedFrom: string) {
  if (redirectedFrom.startsWith('/attorney/')) {
    return '/attorney/login'
  }

  if (redirectedFrom.startsWith('/admin/')) {
    return '/admin/login'
  }

  return '/login'
}

function buildLoginRedirect(path: string, message: string, redirectedFrom: string, email = '') {
  const query = new URLSearchParams()
  query.set('message', message)
  if (redirectedFrom) query.set('redirectedFrom', getSafeRedirectPath(redirectedFrom))
  if (email) query.set('email', email)
  return `${path}?${query.toString()}`
}

function getRequestMode(request: Request) {
  const contentType = String(request.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('application/json')) return 'json' as const
  return 'form' as const
}

async function parsePayload(request: Request): Promise<LoginPayload> {
  const mode = getRequestMode(request)

  if (mode === 'json') {
    const body = (await request.json()) as Record<string, unknown>
    return {
      email: String(body.email ?? '').trim(),
      password: String(body.password ?? ''),
      redirectedFrom: getSafeRedirectPath(String(body.redirectedFrom ?? '').trim() || '/dashboard'),
    }
  }

  const formData = await request.formData()
  return {
    email: String(formData.get('email') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
    redirectedFrom: getSafeRedirectPath(String(formData.get('redirectedFrom') ?? '').trim() || '/dashboard'),
  }
}

function applyCookies(
  response: NextResponse,
  responseCookies: Array<{ name: string; value: string; options?: Parameters<NextResponse['cookies']['set']>[2] }>
) {
  responseCookies.forEach(({ name, value, options }) => {
    response.cookies.set(name, value, options)
  })
  return response
}

export async function POST(request: Request) {
  const mode = getRequestMode(request)
  const requestUrl = new URL(request.url)

  try {
    const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
    const supabaseKey = String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

    if (!supabaseUrl || !supabaseKey) {
      const message = 'Supabase URL and Key are required.'
      if (mode === 'json') {
        return NextResponse.json({ ok: false, error: message }, { status: 500 })
      }
      const redirectUrl = new URL(
        buildLoginRedirect('/login', message, '/dashboard'),
        requestUrl
      )
      return NextResponse.redirect(redirectUrl, 303)
    }

    let payload: LoginPayload
    try {
      payload = await parsePayload(request)
    } catch {
      if (mode === 'json') {
        return NextResponse.json({ ok: false, error: 'Invalid login payload.' }, { status: 400 })
      }
      const redirectUrl = new URL(
        buildLoginRedirect('/login', 'Invalid login payload.', '/dashboard'),
        requestUrl
      )
      return NextResponse.redirect(redirectUrl, 303)
    }

    const { email, password, redirectedFrom } = payload
    const loginPath = getLoginPathForRedirect(redirectedFrom)

    if (!email || !password) {
      const message = 'Email and password are required.'
      if (mode === 'json') {
        return NextResponse.json({ ok: false, error: message }, { status: 400 })
      }
      const redirectUrl = new URL(
        buildLoginRedirect(loginPath, message, redirectedFrom, email),
        requestUrl
      )
      return NextResponse.redirect(redirectUrl, 303)
    }

    const cookieStore = await cookies()
    const responseCookies: Array<{
      name: string
      value: string
      options?: Parameters<NextResponse['cookies']['set']>[2]
    }> = []

    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(nextCookies) {
          nextCookies.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
            responseCookies.push({ name, value, options })
          })
        },
      },
    })

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      const message = mapSignInError(error.message)
      if (mode === 'json') {
        return NextResponse.json({ ok: false, error: message }, { status: 400 })
      }
      const redirectUrl = new URL(
        buildLoginRedirect(loginPath, message, redirectedFrom, email),
        requestUrl
      )
      return NextResponse.redirect(redirectUrl, 303)
    }

    if (mode === 'json') {
      return applyCookies(
        NextResponse.json({
          ok: true,
          redirectTo: redirectedFrom,
        }),
        responseCookies
      )
    }

    return applyCookies(NextResponse.redirect(new URL(redirectedFrom, requestUrl), 303), responseCookies)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to sign in right now.'
    if (mode === 'json') {
      return NextResponse.json({ ok: false, error: message }, { status: 500 })
    }
    const redirectUrl = new URL(buildLoginRedirect('/login', message, '/dashboard'), requestUrl)
    return NextResponse.redirect(redirectUrl, 303)
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, route: 'auth-login' })
}
