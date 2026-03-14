import type { SupabaseClient, User } from '@supabase/supabase-js'

export async function getServerAuthUser(supabase: SupabaseClient): Promise<User | null> {
  const userRes = await supabase.auth.getUser()
  if (userRes.data.user) {
    return userRes.data.user
  }

  const sessionRes = await supabase.auth.getSession()
  return sessionRes.data.session?.user ?? null
}

