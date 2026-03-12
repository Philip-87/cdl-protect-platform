import type { SupabaseClient } from '@supabase/supabase-js'

type QueryClient = Pick<SupabaseClient, 'from'>
type FleetRowFilter = {
  ids?: string[]
  agencyIds?: string[]
  createdBy?: string
}

export type AccessibleFleetOption = {
  id: string
  company_name: string
}

export type AccessibleFleetRow = AccessibleFleetOption & {
  contact_name: string | null
  address: string | null
  email: string | null
  phone: string | null
  agency_id: string | null
  is_active: boolean | null
}

export function extractMissingColumnName(message: string) {
  const patterns = [
    /column\s+((?:"?[a-zA-Z0-9_]+"?\.)*"?[a-zA-Z0-9_]+"?)\s+does not exist/i,
    /could not find the '([a-zA-Z0-9_]+)' column/i,
  ]

  for (const pattern of patterns) {
    const match = message.match(pattern)
    if (match?.[1]) {
      const candidate = match[1].replace(/"/g, '').split('.').pop()?.trim()
      if (candidate) return candidate
    }
  }

  return null
}

function isSchemaDriftError(message: string, code?: string) {
  return (
    code === 'PGRST204' ||
    /column .* does not exist/i.test(message) ||
    /schema cache/i.test(message) ||
    /could not find the '.*' column/i.test(message)
  )
}

async function uniqueAgencyIdsForUser(supabase: QueryClient, userId: string) {
  const agencyMemberships = await supabase
    .from('agency_memberships')
    .select('agency_id')
    .eq('user_id', userId)
    .limit(200)

  return [...new Set((agencyMemberships.data ?? []).map((row) => row.agency_id).filter(Boolean))]
}

async function agencyIdsCreatedByUser(supabase: QueryClient, userId: string) {
  const agencies = await supabase.from('agencies').select('id').eq('created_by', userId).limit(200)
  if (agencies.error) return []
  return [...new Set((agencies.data ?? []).map((row) => row.id).filter(Boolean))]
}

async function uniqueFleetIdsForUser(supabase: QueryClient, userId: string) {
  const fleetMemberships = await supabase
    .from('fleet_memberships')
    .select('fleet_id')
    .eq('user_id', userId)
    .limit(200)

  return [...new Set((fleetMemberships.data ?? []).map((row) => row.fleet_id).filter(Boolean))]
}

async function fleetIdsCreatedByUser(supabase: QueryClient, userId: string) {
  const fleets = await supabase.from('fleets').select('id').eq('created_by', userId).limit(200)
  if (fleets.error) return []
  return [...new Set((fleets.data ?? []).map((row) => row.id).filter(Boolean))]
}

async function selectFleetRowsWithFallback(
  supabase: QueryClient,
  columns: string[],
  filters: FleetRowFilter
) {
  const selectedColumns = [...columns]

  while (selectedColumns.length) {
    let query = supabase.from('fleets').select(selectedColumns.join(', '))
    if (filters.ids?.length) {
      query = query.in('id', filters.ids)
    }
    if (filters.agencyIds?.length) {
      query = query.in('agency_id', filters.agencyIds)
    }
    if (filters.createdBy) {
      query = query.eq('created_by', filters.createdBy)
    }
    const result = await query.order('company_name', { ascending: true })

    if (!result.error) {
      return {
        rows: ((result.data ?? []) as unknown) as Array<Record<string, unknown>>,
        selectedColumns,
      }
    }

    if (!isSchemaDriftError(result.error.message, result.error.code)) {
      return {
        rows: [] as Array<Record<string, unknown>>,
        selectedColumns: [] as string[],
      }
    }

    const missingColumn = extractMissingColumnName(result.error.message)
    if (missingColumn && selectedColumns.includes(missingColumn)) {
      selectedColumns.splice(selectedColumns.indexOf(missingColumn), 1)
      continue
    }

    return {
      rows: [] as Array<Record<string, unknown>>,
      selectedColumns: [] as string[],
    }
  }

  return {
    rows: [] as Array<Record<string, unknown>>,
    selectedColumns: [] as string[],
  }
}

function normalizeFleetRow(row: Record<string, unknown>, selectedColumns: string[]): AccessibleFleetRow {
  return {
    id: String(row.id ?? ''),
    company_name: String(row.company_name ?? ''),
    contact_name: typeof row.contact_name === 'string' ? row.contact_name : null,
    address: typeof row.address === 'string' ? row.address : null,
    email: typeof row.email === 'string' ? row.email : null,
    phone: typeof row.phone === 'string' ? row.phone : null,
    agency_id: typeof row.agency_id === 'string' ? row.agency_id : null,
    is_active:
      selectedColumns.includes('is_active') && typeof row.is_active === 'boolean' ? row.is_active : null,
  }
}

function dedupeFleetRows(rows: AccessibleFleetRow[]) {
  const deduped = new Map<string, AccessibleFleetRow>()
  for (const row of rows) {
    if (row.id) deduped.set(row.id, row)
  }
  return [...deduped.values()].sort((a, b) => a.company_name.localeCompare(b.company_name))
}

const BASE_FLEET_COLUMNS = ['id', 'company_name', 'contact_name', 'address', 'email', 'phone', 'agency_id', 'is_active']

async function getFleetRowsWithFilters(
  supabase: QueryClient,
  filters: FleetRowFilter,
  options?: { includeArchived?: boolean }
) {
  const result = await selectFleetRowsWithFallback(supabase, BASE_FLEET_COLUMNS, filters)
  const rows = dedupeFleetRows(result.rows.map((row) => normalizeFleetRow(row, result.selectedColumns)))

  if (options?.includeArchived) {
    return rows
  }

  return rows.filter((row) => row.is_active !== false)
}

export async function getFleetRowsByIds(
  supabase: QueryClient,
  ids: string[],
  options?: { includeArchived?: boolean }
) {
  if (!ids.length) return []
  return getFleetRowsWithFilters(supabase, { ids }, options)
}

export async function getFleetRowsCreatedByUser(
  supabase: QueryClient,
  userId: string,
  options?: { includeArchived?: boolean }
) {
  return getFleetRowsWithFilters(supabase, { createdBy: userId }, options)
}

export async function getAccessibleFleetRows(
  supabase: QueryClient,
  userId: string,
  options?: { includeArchived?: boolean }
) {
  const directFleetIds = await uniqueFleetIdsForUser(supabase, userId)
  const agencyIds = await uniqueAgencyIdsForUser(supabase, userId)
  const createdAgencyIds = await agencyIdsCreatedByUser(supabase, userId)
  const scopedAgencyIds = [...new Set([...agencyIds, ...createdAgencyIds])]
  const createdFleetIds = await fleetIdsCreatedByUser(supabase, userId)

  const rowSets = await Promise.all([
    createdFleetIds.length
      ? selectFleetRowsWithFallback(supabase, BASE_FLEET_COLUMNS, { ids: createdFleetIds })
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>>, selectedColumns: BASE_FLEET_COLUMNS }),
    directFleetIds.length
      ? selectFleetRowsWithFallback(supabase, BASE_FLEET_COLUMNS, { ids: directFleetIds })
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>>, selectedColumns: BASE_FLEET_COLUMNS }),
    scopedAgencyIds.length
      ? selectFleetRowsWithFallback(supabase, BASE_FLEET_COLUMNS, { agencyIds: scopedAgencyIds })
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>>, selectedColumns: BASE_FLEET_COLUMNS }),
  ])

  const mergedRows = dedupeFleetRows(
    rowSets.flatMap((result) => result.rows.map((row) => normalizeFleetRow(row, result.selectedColumns)))
  )

  if (options?.includeArchived) {
    return mergedRows
  }

  return mergedRows.filter((row) => row.is_active !== false)
}

export async function getAccessibleFleetIds(
  supabase: QueryClient,
  userId: string,
  options?: { includeArchived?: boolean }
) {
  const rows = await getAccessibleFleetRows(supabase, userId, options)
  return rows.map((row) => row.id)
}

export async function getAccessibleFleetOptions(supabase: QueryClient, userId: string) {
  const rows = await getAccessibleFleetRows(supabase, userId)
  return rows.map((row) => ({
    id: row.id,
    company_name: row.company_name,
  }))
}
