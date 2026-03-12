import { createClient } from '@/app/lib/supabase/server'

export async function claimRoleInvitesSafe() {
  try {
    const supabase = await createClient()
    await supabase.rpc('claim_my_invites')
    await supabase.rpc('claim_my_driver_cases')
  } catch {
    // No-op: app should still function if migration has not been applied yet.
  }
}
