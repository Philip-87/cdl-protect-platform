import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

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

export async function POST(request: Request) {
  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const supabaseKey = String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Supabase URL and Key are required.',
      },
      { status: 500 }
    )
  }

  const formData = await request.formData()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const redirectedFrom = getSafeRedirectPath(String(formData.get('redirectedFrom') ?? '').trim() || '/dashboard')

  if (!email || !password) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Email and password are required.',
      },
      { status: 400 }
    )
  }

  let response = NextResponse.json({
    ok: true,
    redirectTo: redirectedFrom,
  })

  const cookieStore = await cookies()
  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options)
        })
      },
    },
  })

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: mapSignInError(error.message),
      },
      { status: 400 }
    )
  }

  return response
}
