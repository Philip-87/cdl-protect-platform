import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL and Key are required. Check your .env.local file.')
  }

  const cookieStore = await cookies()

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // Called from a Server Component where cookies cannot be set.
          // Middleware will refresh the session instead.
        }
      },
    },
  })

  const originalGetUser = supabase.auth.getUser.bind(supabase.auth)
  const originalGetSession = supabase.auth.getSession.bind(supabase.auth)

  supabase.auth.getUser = async (jwt) => {
    const result = await originalGetUser(jwt)
    if (result.data.user || jwt) {
      return result
    }

    const sessionResult = await originalGetSession()
    const sessionUser = sessionResult.data.session?.user ?? null
    if (!sessionUser) {
      return result
    }

    return {
      data: { user: sessionUser },
      error: null,
    }
  }

  return supabase
}
