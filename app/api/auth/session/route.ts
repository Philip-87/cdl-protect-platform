import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

type SessionPayload = {
  access_token: string
  refresh_token: string
}

export async function POST(request: Request) {
  try {
    const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
    const supabaseKey = String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ ok: false, error: 'Supabase URL and Key are required.' }, { status: 500 })
    }

    const body = (await request.json()) as Partial<SessionPayload>
    const accessToken = String(body.access_token ?? '').trim()
    const refreshToken = String(body.refresh_token ?? '').trim()

    if (!accessToken || !refreshToken) {
      return NextResponse.json({ ok: false, error: 'Missing session tokens.' }, { status: 400 })
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

    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 })
    }

    const response = NextResponse.json({ ok: true })
    responseCookies.forEach(({ name, value, options }) => {
      response.cookies.set(name, value, options)
    })

    return response
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unable to persist session.' },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, route: 'auth-session' })
}
