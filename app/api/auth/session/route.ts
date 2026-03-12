import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { applyServerStorage, createStorageFromOptions } from '@supabase/ssr/dist/main/cookies'

type SessionPayload = {
  access_token: string
  refresh_token: string
}

function createResponseCookieBuffer() {
  const responseCookies: Array<{
    name: string
    value: string
    options?: Parameters<NextResponse['cookies']['set']>[2]
  }> = []

  return {
    responseCookies,
    setAll(nextCookies: Array<{ name: string; value: string; options?: Parameters<NextResponse['cookies']['set']>[2] }>) {
      nextCookies.forEach(({ name, value, options }) => {
        responseCookies.push({ name, value, options })
      })
    },
  }
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
    const buffered = createResponseCookieBuffer()

    const storageState = createStorageFromOptions(
      {
        cookieEncoding: 'base64url',
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(nextCookies) {
            nextCookies.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
            buffered.setAll(nextCookies)
          },
        },
      },
      true
    )

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        flowType: 'pkce',
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: true,
        storage: storageState.storage,
      },
      global: {
        headers: {
          'X-Client-Info': 'cdl-protect/auth-session-route',
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

    await applyServerStorage(
      {
        getAll: storageState.getAll,
        setAll: storageState.setAll,
        setItems: storageState.setItems,
        removedItems: storageState.removedItems,
      },
      {
        cookieEncoding: 'base64url',
        cookieOptions: null,
      }
    )

    const response = NextResponse.json({ ok: true })
    buffered.responseCookies.forEach(({ name, value, options }) => {
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
