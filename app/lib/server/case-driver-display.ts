import type { SupabaseClient } from '@supabase/supabase-js'
import { getCaseDisplayDriverName } from '@/app/lib/cases/display'

type QueryClient = Pick<SupabaseClient, 'from'>

type DriverNameCarrier = {
  driver_id?: string | null
  metadata?: Record<string, unknown> | null
}

type DriverRow = {
  id: string
  user_id: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
}

type ProfileRow = {
  id: string
  user_id: string | null
  full_name: string | null
  email: string | null
}

function getCaseMetadata(row: DriverNameCarrier) {
  return row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
}

function getDriverLabel(driver: DriverRow | null | undefined, profile: ProfileRow | null | undefined) {
  const fullName = [driver?.first_name, driver?.last_name].filter(Boolean).join(' ').trim()
  return fullName || String(profile?.full_name ?? '').trim() || String(driver?.email ?? '').trim() || String(profile?.email ?? '').trim() || null
}

async function loadDriverRows(supabase: QueryClient, driverIds: string[]) {
  if (!driverIds.length) return [] as DriverRow[]
  const result = await supabase.from('drivers').select('id, user_id, email, first_name, last_name').in('id', driverIds)
  return (result.data ?? []) as DriverRow[]
}

async function loadProfileRows(supabase: QueryClient, ids: string[]) {
  const deduped = [...new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))]
  if (!deduped.length) return [] as ProfileRow[]

  const rows: ProfileRow[] = []
  const byIdRes = await supabase.from('profiles').select('id, user_id, full_name, email').in('id', deduped)
  rows.push(...(((byIdRes.data ?? []) as ProfileRow[]) || []))

  const unresolved = deduped.filter((id) => !rows.some((row) => row.id === id || row.user_id === id))
  if (unresolved.length) {
    const byUserRes = await supabase.from('profiles').select('id, user_id, full_name, email').in('user_id', unresolved)
    rows.push(...(((byUserRes.data ?? []) as ProfileRow[]) || []))
  }

  return rows
}

export async function hydrateCaseDriverNames<T extends DriverNameCarrier>(supabase: QueryClient, rows: T[]) {
  const driverIdsNeedingLookup = [...new Set(
    rows
      .filter((row) => getCaseDisplayDriverName(row) === '-')
      .map((row) => String(row.driver_id ?? '').trim())
      .filter(Boolean)
  )]

  if (!driverIdsNeedingLookup.length) return rows

  const drivers = await loadDriverRows(supabase, driverIdsNeedingLookup)
  if (!drivers.length) return rows

  const profiles = await loadProfileRows(
    supabase,
    drivers.flatMap((driver) => [driver.id, String(driver.user_id ?? '').trim()]).filter(Boolean)
  )

  const driverById = new Map<string, DriverRow>()
  const profileById = new Map<string, ProfileRow>()

  for (const driver of drivers) {
    driverById.set(driver.id, driver)
    if (driver.user_id) driverById.set(driver.user_id, driver)
  }

  for (const profile of profiles) {
    if (profile.id) profileById.set(profile.id, profile)
    if (profile.user_id) profileById.set(profile.user_id, profile)
  }

  return rows.map((row) => {
    if (getCaseDisplayDriverName(row) !== '-') return row

    const driverId = String(row.driver_id ?? '').trim()
    if (!driverId) return row

    const driver = driverById.get(driverId)
    const profile = profileById.get(driverId) ?? (driver?.user_id ? profileById.get(driver.user_id) : null)
    const label = getDriverLabel(driver, profile)
    if (!label) return row

    return {
      ...row,
      metadata: {
        ...getCaseMetadata(row),
        driver_name: label,
      },
    }
  })
}
