import type { SupabaseClient } from '@supabase/supabase-js'

type QueryClient = Pick<SupabaseClient, 'from'>

export type AccessibleAgencyOption = {
  id: string
  company_name: string
}

async function getAgencyIdsFromMemberships(supabase: QueryClient, userId: string) {
  const memberships = await supabase.from('agency_memberships').select('agency_id').eq('user_id', userId).limit(200)
  if (memberships.error) return []
  return (memberships.data ?? []).map((row) => row.agency_id).filter(Boolean)
}

async function getAgencyIdsCreatedByUser(supabase: QueryClient, userId: string) {
  const agencies = await supabase.from('agencies').select('id').eq('created_by', userId).limit(200)
  if (agencies.error) return []
  return (agencies.data ?? []).map((row) => row.id).filter(Boolean)
}

export async function getAccessibleAgencyIds(supabase: QueryClient, userId: string) {
  return [...new Set([...(await getAgencyIdsFromMemberships(supabase, userId)), ...(await getAgencyIdsCreatedByUser(supabase, userId))])]
}

export async function getAccessibleAgencyOptions(supabase: QueryClient, userId: string) {
  const agencyIds = await getAccessibleAgencyIds(supabase, userId)
  if (!agencyIds.length) return []

  const agencies = await supabase
    .from('agencies')
    .select('id, company_name')
    .in('id', agencyIds)
    .order('company_name', { ascending: true })
    .limit(200)

  if (agencies.error) return []

  return [...new Map((agencies.data ?? []).map((row) => [row.id, { id: row.id, company_name: row.company_name ?? row.id }])).values()]
}
