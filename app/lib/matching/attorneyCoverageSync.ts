import { createServiceRoleClient } from '@/app/lib/supabase/service-role'
import { normalizeCountyName } from '@/app/lib/matching/county'

type OnboardingProfileRow = {
  id: string
  user_id: string
  firm_id: string | null
  full_name: string
  email: string
  phone: string
  state: string
  office_address: string
  city: string | null
  zip_code: string
  fee_mode: string
  cdl_flat_fee: number | string | null
  non_cdl_flat_fee: number | string | null
  counties: unknown
  primary_county: string | null
  metadata: Record<string, unknown> | null
}

type CountyFeeRow = {
  attorney_profile_id: string
  state: string
  county_name: string
  cdl_fee: number | string
  non_cdl_fee: number | string
}

type SyncResult = {
  ok: boolean
  syncedCount: number
  createdFirmCount: number
  errors: string[]
}

function normalizeState(value: unknown) {
  return String(value ?? '').trim().toUpperCase()
}

function normalizeCounty(value: unknown) {
  return normalizeCountyName(value)
}

function toDisplayCounty(value: unknown) {
  return String(value ?? '').trim()
}

function parseJsonStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean) : []
    } catch {
      return value
        .split(/[;,|]/)
        .map((item) => item.trim())
        .filter(Boolean)
    }
  }

  return []
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function dollarsToCents(value: number | string | null | undefined) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.round(parsed * 100)
}

function buildCoverageCounties(profile: OnboardingProfileRow, countyFees: CountyFeeRow[]) {
  const countyValues = [
    ...parseJsonStringArray(profile.counties),
    ...countyFees.map((row) => toDisplayCounty(row.county_name)),
    toDisplayCounty(profile.primary_county),
  ]
  return uniqueStrings(countyValues)
}

function buildGlobalPricingRows(profile: OnboardingProfileRow, firmId: string, counties: string[]) {
  const cdlFeeCents = dollarsToCents(profile.cdl_flat_fee)
  const nonCdlFeeCents = dollarsToCents(profile.non_cdl_flat_fee)
  if (!cdlFeeCents || !nonCdlFeeCents) return []

  return counties
    .map((county) => normalizeCounty(county))
    .filter(Boolean)
    .map((county) => ({
      law_firm_org_id: firmId,
      state: normalizeState(profile.state),
      county,
      cdl_fee_cents: cdlFeeCents,
      non_cdl_fee_cents: nonCdlFeeCents,
      is_active: true,
      source: 'ONBOARDING',
      updated_by: profile.user_id,
    }))
}

function buildCountyPricingRows(profile: OnboardingProfileRow, firmId: string, countyFees: CountyFeeRow[]) {
  return countyFees
    .map((row) => {
      const cdlFeeCents = dollarsToCents(row.cdl_fee)
      const nonCdlFeeCents = dollarsToCents(row.non_cdl_fee)
      return {
        law_firm_org_id: firmId,
        state: normalizeState(row.state || profile.state),
        county: normalizeCounty(row.county_name),
        cdl_fee_cents: cdlFeeCents,
        non_cdl_fee_cents: nonCdlFeeCents,
        is_active: true,
        source: 'ONBOARDING',
        updated_by: profile.user_id,
      }
    })
    .filter(
      (row): row is NonNullable<typeof row> =>
        Boolean(row.state && row.county && row.cdl_fee_cents && row.non_cdl_fee_cents)
    )
}

async function ensureAttorneyFirm(profile: OnboardingProfileRow, counties: string[]) {
  const admin = createServiceRoleClient()

  const membership = await admin
    .from('attorney_firm_memberships')
    .select('firm_id')
    .eq('user_id', profile.user_id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ firm_id: string }>()

  if (membership.error) {
    throw new Error(membership.error.message)
  }

  const normalizedEmail = String(profile.email ?? '').trim().toLowerCase()
  let firmId = profile.firm_id ?? membership.data?.firm_id ?? null
  let created = false

  if (!firmId && normalizedEmail) {
    const existingFirm = await admin
      .from('attorney_firms')
      .select('id')
      .eq('email', normalizedEmail)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle<{ id: string }>()

    if (existingFirm.error) {
      throw new Error(existingFirm.error.message)
    }

    firmId = existingFirm.data?.id ?? null
  }

  if (!firmId) {
    const createdFirm = await admin
      .from('attorney_firms')
      .insert({
        company_name: profile.full_name || normalizedEmail || 'Attorney Firm',
        contact_name: profile.full_name || null,
        email: normalizedEmail || null,
        phone: profile.phone || null,
        state: normalizeState(profile.state) || null,
        counties,
        coverage_notes: 'Synced from attorney onboarding.',
        is_active: true,
        created_by: profile.user_id,
      })
      .select('id')
      .single<{ id: string }>()

    if (createdFirm.error || !createdFirm.data?.id) {
      throw new Error(createdFirm.error?.message || 'Could not create attorney firm.')
    }

    firmId = createdFirm.data.id
    created = true
  }

  const firmPatch: Record<string, unknown> = {
    contact_name: profile.full_name || null,
    email: normalizedEmail || null,
    phone: profile.phone || null,
    state: normalizeState(profile.state) || null,
    counties,
    coverage_notes: 'Synced from attorney onboarding.',
    is_active: true,
    coverage_states: normalizeState(profile.state) ? [normalizeState(profile.state)] : [],
    primary_county: toDisplayCounty(profile.primary_county) || counties[0] || null,
    office_address: profile.office_address || null,
    city: profile.city || null,
    zip_code: profile.zip_code || null,
    updated_at: new Date().toISOString(),
  }

  let updateAttempt = await admin.from('attorney_firms').update(firmPatch).eq('id', firmId)
  if (updateAttempt.error && /column .* does not exist/i.test(updateAttempt.error.message)) {
    delete firmPatch.coverage_states
    delete firmPatch.primary_county
    delete firmPatch.office_address
    delete firmPatch.city
    delete firmPatch.zip_code
    updateAttempt = await admin.from('attorney_firms').update(firmPatch).eq('id', firmId)
  }
  if (updateAttempt.error) {
    throw new Error(updateAttempt.error.message)
  }

  const membershipUpsert = await admin.from('attorney_firm_memberships').upsert(
    {
      firm_id: firmId,
      user_id: profile.user_id,
      role_in_firm: 'attorney_admin',
    },
    { onConflict: 'firm_id,user_id' }
  )
  if (membershipUpsert.error) {
    throw new Error(membershipUpsert.error.message)
  }

  if (profile.firm_id !== firmId) {
    const profileUpdate = await admin
      .from('attorney_onboarding_profiles')
      .update({ firm_id: firmId })
      .eq('id', profile.id)
    if (profileUpdate.error) {
      throw new Error(profileUpdate.error.message)
    }
  }

  return { firmId, created }
}

async function syncDirectoryRow(profile: OnboardingProfileRow, firmId: string, counties: string[]) {
  const admin = createServiceRoleClient()
  const normalizedState = normalizeState(profile.state)
  const normalizedEmail = String(profile.email ?? '').trim().toLowerCase()

  if (!normalizedState || !normalizedEmail) return

  const payload = {
    import_key: `onboarding:${profile.id}`,
    name: profile.full_name || normalizedEmail,
    email: normalizedEmail,
    phone: profile.phone || null,
    state: normalizedState,
    address: profile.office_address || null,
    is_statewide: counties.length === 0,
    counties,
    metadata: {
      source: 'ONBOARDING',
      attorney_profile_id: profile.id,
      attorney_user_id: profile.user_id,
      firm_id: firmId,
    },
    updated_at: new Date().toISOString(),
  }

  const existingByImportKey = await admin
    .from('attorney_directory')
    .select('id')
    .eq('import_key', payload.import_key)
    .limit(1)
    .maybeSingle<{ id: string }>()

  if (existingByImportKey.error) {
    throw new Error(existingByImportKey.error.message)
  }

  const existingByEmail = existingByImportKey.data?.id
    ? { data: null, error: null }
    : await admin
        .from('attorney_directory')
        .select('id')
        .ilike('email', normalizedEmail)
        .eq('state', normalizedState)
        .limit(1)
        .maybeSingle<{ id: string }>()

  if (existingByEmail.error) {
    throw new Error(existingByEmail.error.message)
  }

  const existingId = existingByImportKey.data?.id ?? existingByEmail.data?.id ?? null
  if (existingId) {
    const update = await admin.from('attorney_directory').update(payload).eq('id', existingId)
    if (update.error) {
      throw new Error(update.error.message)
    }
    return
  }

  const insert = await admin.from('attorney_directory').insert(payload)
  if (insert.error) {
    throw new Error(insert.error.message)
  }
}

async function syncPricingRows(profile: OnboardingProfileRow, firmId: string, countyFees: CountyFeeRow[], counties: string[]) {
  const admin = createServiceRoleClient()
  const normalizedState = normalizeState(profile.state)
  if (!normalizedState) return

  const pricingRows =
    String(profile.fee_mode ?? '').trim().toUpperCase() === 'BY_COUNTY'
      ? buildCountyPricingRows(profile, firmId, countyFees)
      : buildGlobalPricingRows(profile, firmId, counties)

  const activeCounties = new Set(pricingRows.map((row) => row.county))

  const existing = await admin
    .from('attorney_pricing')
    .select('id, county')
    .eq('law_firm_org_id', firmId)
    .eq('state', normalizedState)
    .eq('source', 'ONBOARDING')

  if (existing.error) {
    throw new Error(existing.error.message)
  }

  if (pricingRows.length) {
    const upsert = await admin.from('attorney_pricing').upsert(pricingRows, {
      onConflict: 'law_firm_org_id,state,county',
    })
    if (upsert.error) {
      throw new Error(upsert.error.message)
    }
  }

  const staleIds = (existing.data ?? [])
    .filter((row) => !activeCounties.has(normalizeCounty(row.county)))
    .map((row) => row.id)

  if (staleIds.length) {
    const deactivate = await admin
      .from('attorney_pricing')
      .update({
        is_active: false,
        updated_by: profile.user_id,
        updated_at: new Date().toISOString(),
      })
      .in('id', staleIds)

    if (deactivate.error) {
      throw new Error(deactivate.error.message)
    }
  }
}

async function syncSingleProfile(profile: OnboardingProfileRow, countyFees: CountyFeeRow[]) {
  const counties = buildCoverageCounties(profile, countyFees)
  const { firmId, created } = await ensureAttorneyFirm(profile, counties)
  await syncDirectoryRow(profile, firmId, counties)
  await syncPricingRows(profile, firmId, countyFees, counties)
  return { created }
}

async function loadProfilesByFilter(filter: { profileId?: string; userId?: string; state?: string }) {
  const admin = createServiceRoleClient()
  let query = admin
    .from('attorney_onboarding_profiles')
    .select(
      'id, user_id, firm_id, full_name, email, phone, state, office_address, city, zip_code, fee_mode, cdl_flat_fee, non_cdl_flat_fee, counties, primary_county, metadata'
    )

  if (filter.profileId) {
    query = query.eq('id', filter.profileId)
  }
  if (filter.userId) {
    query = query.eq('user_id', filter.userId)
  }
  if (filter.state) {
    query = query.eq('state', normalizeState(filter.state))
  }

  const profilesRes = await query
  if (profilesRes.error) {
    throw new Error(profilesRes.error.message)
  }

  return (profilesRes.data ?? []) as OnboardingProfileRow[]
}

async function loadCountyFees(profileIds: string[], state?: string) {
  if (!profileIds.length) return [] as CountyFeeRow[]
  const admin = createServiceRoleClient()
  let query = admin
    .from('attorney_county_fees')
    .select('attorney_profile_id, state, county_name, cdl_fee, non_cdl_fee')
    .in('attorney_profile_id', profileIds)

  if (state) {
    query = query.eq('state', normalizeState(state))
  }

  const feesRes = await query
  if (feesRes.error) {
    throw new Error(feesRes.error.message)
  }

  return (feesRes.data ?? []) as CountyFeeRow[]
}

function profileCanCoverCounty(profile: OnboardingProfileRow, county: string, countyFees: CountyFeeRow[]) {
  const normalizedCounty = normalizeCounty(county)
  if (!normalizedCounty) return true

  const coverageCounties = buildCoverageCounties(profile, countyFees).map((value) => normalizeCounty(value))
  return coverageCounties.length === 0 || coverageCounties.includes(normalizedCounty)
}

async function syncProfiles(profiles: OnboardingProfileRow[], feesByProfileId: Map<string, CountyFeeRow[]>) {
  let syncedCount = 0
  let createdFirmCount = 0
  const errors: string[] = []

  for (const profile of profiles) {
    try {
      const result = await syncSingleProfile(profile, feesByProfileId.get(profile.id) ?? [])
      syncedCount += 1
      if (result.created) createdFirmCount += 1
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Attorney matching sync failed.')
    }
  }

  return {
    ok: errors.length === 0,
    syncedCount,
    createdFirmCount,
    errors,
  }
}

export async function syncAttorneyMatchingCoverageForUser(userId: string): Promise<SyncResult> {
  const profiles = await loadProfilesByFilter({ userId })
  const countyFees = await loadCountyFees(
    profiles.map((profile) => profile.id),
    profiles[0]?.state
  )
  const feesByProfileId = new Map<string, CountyFeeRow[]>()
  for (const row of countyFees) {
    const existing = feesByProfileId.get(row.attorney_profile_id) ?? []
    existing.push(row)
    feesByProfileId.set(row.attorney_profile_id, existing)
  }
  return syncProfiles(profiles, feesByProfileId)
}

export async function syncAttorneyMatchingCoverageForProfile(profileId: string): Promise<SyncResult> {
  const profiles = await loadProfilesByFilter({ profileId })
  const countyFees = await loadCountyFees(profiles.map((profile) => profile.id), profiles[0]?.state)
  const feesByProfileId = new Map<string, CountyFeeRow[]>()
  for (const row of countyFees) {
    const existing = feesByProfileId.get(row.attorney_profile_id) ?? []
    existing.push(row)
    feesByProfileId.set(row.attorney_profile_id, existing)
  }
  return syncProfiles(profiles, feesByProfileId)
}

export async function syncAttorneyMatchingCoverageForJurisdiction(params: {
  state: string | null | undefined
  county: string | null | undefined
}): Promise<SyncResult> {
  const normalizedState = normalizeState(params.state)
  const normalizedCounty = normalizeCounty(params.county)
  if (!normalizedState) {
    return { ok: true, syncedCount: 0, createdFirmCount: 0, errors: [] }
  }

  const profiles = await loadProfilesByFilter({ state: normalizedState })
  const countyFees = await loadCountyFees(profiles.map((profile) => profile.id), normalizedState)
  const feesByProfileId = new Map<string, CountyFeeRow[]>()
  for (const row of countyFees) {
    const existing = feesByProfileId.get(row.attorney_profile_id) ?? []
    existing.push(row)
    feesByProfileId.set(row.attorney_profile_id, existing)
  }

  const relevantProfiles = normalizedCounty
    ? profiles.filter((profile) => profileCanCoverCounty(profile, normalizedCounty, feesByProfileId.get(profile.id) ?? []))
    : profiles

  return syncProfiles(relevantProfiles, feesByProfileId)
}
