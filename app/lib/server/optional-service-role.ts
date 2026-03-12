import { createServiceRoleClient } from '@/app/lib/supabase/service-role'

export function getOptionalServiceRoleClient() {
  try {
    return createServiceRoleClient()
  } catch {
    return null
  }
}
