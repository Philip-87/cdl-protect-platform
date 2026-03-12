import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export function createServiceRoleClient() {
  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Service-role Supabase client is not configured.')
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
