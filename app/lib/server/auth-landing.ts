import type { SupabaseClient } from '@supabase/supabase-js'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'

type RoleRow = {
  system_role: string | null
}

export async function getAuthenticatedLandingPath(supabase: SupabaseClient, userId: string) {
  const byId = await supabase.from('profiles').select('system_role').eq('id', userId).maybeSingle<RoleRow>()
  const byUserId =
    byId.data ||
    (
      await supabase
        .from('profiles')
        .select('system_role')
        .eq('user_id', userId)
        .maybeSingle<RoleRow>()
    ).data

  const role = normalizePlatformRole(byUserId?.system_role)
  if (isAttorneyRole(role)) return '/attorney/dashboard'
  if (isStaffRole(role)) return '/admin/dashboard'
  return '/dashboard'
}
