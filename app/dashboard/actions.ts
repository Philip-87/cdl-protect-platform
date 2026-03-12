'use server'

import type { SupabaseClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getAccessibleAgencyIds } from '@/app/lib/server/agency-access'
import { createClient } from '@/app/lib/supabase/server'
import {
  getCsvValue,
  parseCaseDateInput,
  parseCsvRows,
  normalizeCaseStatusValue,
  splitDriverName,
} from '@/app/lib/server/case-csv'
import { transitionCaseStatus } from '@/app/lib/server/case-status-transition'
import { getAccessibleFleetIds } from '@/app/lib/server/fleet-access'
import { sendAuthInviteEmail } from '@/app/lib/server/invite-email'
import { writePlatformLog } from '@/app/lib/server/platform-logs'
import { createStripeCheckoutSession, getAppBaseUrl, isStripeConfigured } from '@/app/lib/server/stripe'
import {
  isAgencyRole,
  isAttorneyRole,
  isStaffRole,
  normalizePlatformRole,
  roleCanCreateFleet,
  roleCanInvite,
  type PlatformRole,
} from '@/app/lib/roles'

type UserScope = {
  agencyId: string | null
  fleetId: string | null
  firmId: string | null
}

type QueryClient = Pick<SupabaseClient, 'from'>

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getSetupHint(message: string) {
  if (/CASE_STATUS_TRANSITION_BLOCKED|transition to .* is not allowed/i.test(message)) {
    return 'Requested case status transition is blocked by workflow policy for your role or current state.'
  }

  if (/CASE_STATUS_ACCESS_DENIED|Case not found or access denied/i.test(message)) {
    return 'You do not have access to perform this status transition.'
  }

  if (/42P17/i.test(message)) {
    return 'Supabase RLS recursion (42P17). Re-run migrations 20260225 and 20260226.'
  }

  if (/invalid input value for enum case_status/i.test(message)) {
    return 'Case status enum mismatch in Supabase. Run migrations 20260225 and 20260226.'
  }

  if (/infinite recursion detected in policy/i.test(message)) {
    return 'Supabase has conflicting old RLS policies. Run migration 20260226_role_based_case_platform.sql.'
  }

  if (/relation .* does not exist/i.test(message) || /schema cache/i.test(message)) {
    return 'Database objects are missing. Run all Supabase migrations, then try again.'
  }

  if (/row-level security/i.test(message) || /violates row-level security policy/i.test(message)) {
    return 'Permission denied by RLS policy. Verify roles and latest migrations.'
  }

  return message
}

function getMissingColumnName(message: string) {
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

function isDriverConstraintError(message: string) {
  return (
    /driver_id/i.test(message) &&
    (/violates not-null constraint/i.test(message) ||
      /foreign key constraint/i.test(message) ||
      /cases_driver_id_fkey/i.test(message))
  )
}

function isRelationMissing(message: string) {
  return /relation .* does not exist/i.test(message) || /schema cache/i.test(message)
}

function isCaseAssignmentCompatError(message: string) {
  const normalized = String(message ?? '')
  return (
    /case_assignments_law_firm_org_id_fkey/i.test(normalized) ||
    /case_assignments_firm_id_fkey/i.test(normalized) ||
    ((/foreign key constraint/i.test(normalized) || /violates not-null constraint/i.test(normalized)) &&
      /(law_firm_org_id|firm_id)/i.test(normalized)) ||
    (/null value in column/i.test(normalized) && /(law_firm_org_id|firm_id)/i.test(normalized))
  )
}

async function insertCaseAssignmentCompat(
  supabase: QueryClient,
  params: { caseId: string; firmId: string; offeredBy: string; expiresAt: string }
) {
  const variants: Array<Record<string, string>> = [
    {
      case_id: params.caseId,
      firm_id: params.firmId,
      offered_by: params.offeredBy,
      expires_at: params.expiresAt,
    },
    {
      case_id: params.caseId,
      firm_id: params.firmId,
      law_firm_org_id: params.firmId,
      offered_by: params.offeredBy,
      expires_at: params.expiresAt,
    },
    {
      case_id: params.caseId,
      law_firm_org_id: params.firmId,
      offered_by: params.offeredBy,
      expires_at: params.expiresAt,
    },
  ]

  let lastError = ''
  for (const payload of variants) {
    const insert = await supabase.from('case_assignments').insert(payload)
    if (!insert.error) {
      return { ok: true as const }
    }

    lastError = insert.error.message
    if (isCaseAssignmentCompatError(insert.error.message)) {
      continue
    }

    return { ok: false as const, error: insert.error.message }
  }

  return { ok: false as const, error: lastError || 'Could not create case assignment.' }
}

function getReturnPath(formData: FormData, fallbackPath: string) {
  const requested = String(formData.get('return_to') ?? '').trim()
  if (!requested.startsWith('/')) return fallbackPath
  if (requested.startsWith('//')) return fallbackPath
  return requested
}

function parseUuidOrNull(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  return UUID_PATTERN.test(trimmed) ? trimmed : null
}

function buildReturnPathWithMessage(
  returnPath: string,
  message: string,
  extraParams?: Record<string, string | null | undefined>
) {
  const next = new URL(returnPath, 'http://local.test')
  next.searchParams.set('message', message)
  for (const [key, value] of Object.entries(extraParams ?? {})) {
    if (!value) {
      next.searchParams.delete(key)
      continue
    }
    next.searchParams.set(key, value)
  }
  return `${next.pathname}${next.search}${next.hash}`
}

async function getCurrentUserAndRole(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const profileById = await supabase
    .from('profiles')
    .select('system_role')
    .eq('id', user.id)
    .maybeSingle<{ system_role: string | null }>()

  if (!profileById.error && profileById.data) {
    return { user, role: normalizePlatformRole(profileById.data.system_role) }
  }

  const profileByUserId = await supabase
    .from('profiles')
    .select('system_role')
    .eq('user_id', user.id)
    .maybeSingle<{ system_role: string | null }>()

  return {
    user,
    role: normalizePlatformRole(profileByUserId.data?.system_role ?? 'NONE'),
  }
}

async function resolveScopeForUser(
  supabase: QueryClient,
  userId: string
): Promise<UserScope> {
  let agencyId: string | null = null
  let fleetId: string | null = null
  let firmId: string | null = null

  const createdAgency = await supabase
    .from('agencies')
    .select('id')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>()
  if (!createdAgency.error && createdAgency.data?.id) {
    agencyId = createdAgency.data.id
  }

  const agencyMembership = await supabase
    .from('agency_memberships')
    .select('agency_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle<{ agency_id: string }>()
  if (!agencyMembership.error && agencyMembership.data?.agency_id) {
    agencyId = agencyMembership.data.agency_id
  }

  const createdFleet = await supabase
    .from('fleets')
    .select('id, agency_id')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; agency_id: string | null }>()
  if (!createdFleet.error && createdFleet.data?.id) {
    fleetId = createdFleet.data.id
    agencyId = agencyId ?? createdFleet.data.agency_id ?? null
  }

  const fleetMembership = await supabase
    .from('fleet_memberships')
    .select('fleet_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle<{ fleet_id: string }>()
  if (!fleetMembership.error && fleetMembership.data?.fleet_id) {
    fleetId = fleetMembership.data.fleet_id
  }

  if (fleetId && !agencyId) {
    const fleet = await supabase
      .from('fleets')
      .select('agency_id')
      .eq('id', fleetId)
      .maybeSingle<{ agency_id: string | null }>()
    if (!fleet.error && fleet.data?.agency_id) {
      agencyId = fleet.data.agency_id
    }
  }

  const firmMembership = await supabase
    .from('attorney_firm_memberships')
    .select('firm_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle<{ firm_id: string }>()
  if (!firmMembership.error && firmMembership.data?.firm_id) {
    firmId = firmMembership.data.firm_id
  }

  return {
    agencyId,
    fleetId,
    firmId,
  }
}

async function ensureDriverRowForUser(
  supabase: QueryClient,
  userId: string,
  email: string | null
) {
  const existing = await supabase
    .from('drivers')
    .select('id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle<{ id: string }>()

  if (!existing.error && existing.data?.id) {
    return existing.data.id
  }

  const upsert = await supabase
    .from('drivers')
    .upsert(
      {
        id: userId,
        user_id: userId,
        email: email || null,
      },
      { onConflict: 'user_id' }
    )
    .select('id')
    .maybeSingle<{ id: string }>()

  if (!upsert.error && upsert.data?.id) {
    return upsert.data.id
  }

  const byId = await supabase
    .from('drivers')
    .select('id')
    .eq('id', userId)
    .limit(1)
    .maybeSingle<{ id: string }>()

  return !byId.error && byId.data?.id ? byId.data.id : null
}

async function insertCaseSafe(
  supabase: QueryClient,
  payload: Record<string, unknown>,
  options?: { driverId?: string | null }
) {
  const insertPayload = { ...payload }
  let lastErrorMessage = 'Could not create case.'
  let attemptedDriverResolution = false

  while (Object.keys(insertPayload).length) {
    const { error } = await supabase.from('cases').insert(insertPayload)

    if (!error) return null

    lastErrorMessage = error.message

    if (!attemptedDriverResolution && isDriverConstraintError(error.message)) {
      attemptedDriverResolution = true

      if (options?.driverId) {
        const retry = await supabase.from('cases').insert({
          ...insertPayload,
          driver_id: options.driverId,
        })

        if (!retry.error) return null
        lastErrorMessage = retry.error.message
      }

      if ('driver_id' in insertPayload) {
        delete insertPayload.driver_id
        continue
      }
    }

    const missingColumn = getMissingColumnName(error.message)
    const isSchemaDriftError =
      error.code === 'PGRST204' ||
      /column .* does not exist/i.test(error.message) ||
      /schema cache/i.test(error.message) ||
      /could not find the '.*' column/i.test(error.message)

    if (!isSchemaDriftError) break

    if (missingColumn && missingColumn in insertPayload) {
      delete insertPayload[missingColumn]
      continue
    }

    let removedAny = false
    for (const column of ['notes', 'created_by', 'metadata', 'agency_id', 'fleet_id', 'attorney_firm_id']) {
      if (column in insertPayload) {
        delete insertPayload[column]
        removedAny = true
      }
    }
    if (!removedAny) break
  }

  return lastErrorMessage
}

function uniqueIds(values: FormDataEntryValue[]) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
}

async function resolveFleetAssignmentTarget(
  supabase: QueryClient,
  userId: string,
  role: PlatformRole,
  fleetId: string
) {
  if (!isStaffRole(role)) {
    const accessibleFleetIds = await getAccessibleFleetIds(supabase, userId)
    if (!accessibleFleetIds.includes(fleetId)) {
      return {
        error: 'Selected fleet is outside your workspace scope.',
        fleet: null,
      }
    }
  }

  const fleetRes = await supabase
    .from('fleets')
    .select('id, agency_id, company_name')
    .eq('id', fleetId)
    .maybeSingle<{ id: string; agency_id: string | null; company_name: string | null }>()

  if (fleetRes.error || !fleetRes.data) {
    return {
      error: getSetupHint(fleetRes.error?.message || 'Fleet not found.'),
      fleet: null,
    }
  }

  return {
    error: null,
    fleet: fleetRes.data,
  }
}

export async function createCase(formData: FormData) {
  const state = String(formData.get('state') ?? '')
    .trim()
    .toUpperCase()
  const county = String(formData.get('county') ?? '').trim()
  const citationNumber = String(formData.get('citation_number') ?? '').trim()
  const violationCode = String(formData.get('violation_code') ?? '').trim()
  const violationDate = parseCaseDateInput(String(formData.get('violation_date') ?? ''))
  const courtDate = String(formData.get('court_date') ?? '').trim()
  const courtCaseNumber = String(formData.get('court_case_number') ?? '').trim()
  const courtName = String(formData.get('court_name') ?? '').trim()
  const notes = String(formData.get('notes') ?? '').trim()

  if (!state || !citationNumber) {
    redirect('/dashboard?message=State%20and%20citation%20number%20are%20required.')
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)
  const scope = await resolveScopeForUser(supabase, user.id)
  const driverId = role === 'DRIVER' ? await ensureDriverRowForUser(supabase, user.id, user.email ?? null) : null

  const insertPayload = {
    owner_id: user.id,
    user_id: user.id,
    created_by: user.id,
    driver_id: driverId,
    agency_id: scope.agencyId,
    fleet_id: scope.fleetId,
    attorney_firm_id: scope.firmId,
    submitter_email: user.email ?? null,
    submitter_user_id: user.id,
    state,
    county: county || null,
    citation_number: citationNumber,
    violation_code: violationCode || null,
    violation_date: violationDate,
    court_date: courtDate || null,
    court_case_number: courtCaseNumber || null,
    court_name: courtName || null,
    notes: notes || null,
  }

  const insertError = await insertCaseSafe(supabase, insertPayload, { driverId })
  if (insertError) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(insertError))}`)
  }

  revalidatePath('/dashboard')
  redirect('/dashboard?message=Case%20created%20successfully.')
}

export async function importScopedCasesCsv(formData: FormData) {
  const file = formData.get('csv_file')
  const returnPath = getReturnPath(formData, '/dashboard#case-import')

  if (!(file instanceof File) || file.size === 0) {
    redirect(buildReturnPathWithMessage(returnPath, 'Choose a CSV file to import existing cases.'))
  }

  const csvText = await file.text()
  const rows = parseCsvRows(csvText)
  if (!rows.length) {
    redirect(buildReturnPathWithMessage(returnPath, 'CSV file did not contain importable rows.'))
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!isStaffRole(role) && !isAgencyRole(role) && role !== 'FLEET') {
    redirect(buildReturnPathWithMessage(returnPath, 'Only agency, fleet, or admin roles can import cases from CSV.'))
  }

  const scope = await resolveScopeForUser(supabase, user.id)
  if ((isAgencyRole(role) || role === 'FLEET') && !scope.agencyId) {
    redirect(buildReturnPathWithMessage(returnPath, 'No agency scope was found for your account.'))
  }

  const accessibleFleetIds = new Set(await getAccessibleFleetIds(supabase, user.id))
  let processed = 0
  let skipped = 0
  let failed = 0
  let imported = 0
  const errors: string[] = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const lineNumber = index + 2
    const state = getCsvValue(row, ['state', 'ticket_state']).toUpperCase()
    const county = getCsvValue(row, ['county'])
    const citationNumber = getCsvValue(row, ['citation_number', 'citation', 'ticket_number', 'ticket'])
    const violationCode = getCsvValue(row, ['violation_code', 'violation'])
    const violationDate = parseCaseDateInput(
      getCsvValue(row, ['violation_date', 'date_of_violation', 'ticket_violation_date'])
    )
    const courtDate = parseCaseDateInput(getCsvValue(row, ['court_date', 'court_date_ymd']))
    const courtName = getCsvValue(row, ['court_name'])
    const courtAddress = getCsvValue(row, ['court_address'])
    const courtTime = getCsvValue(row, ['court_time', 'court_hearing_time', 'court_hearing'])
    const courtCaseNumber = getCsvValue(row, ['court_case_number', 'case_ref', 'case_reference'])
    const status = normalizeCaseStatusValue(getCsvValue(row, ['status', 'ticket_status', 'ticket_stage']))
    const notes = getCsvValue(row, ['notes', 'intake_notes'])
    const driverName = getCsvValue(row, ['driver_name', 'client_name', 'driver', 'name'])
    let firstName = getCsvValue(row, ['first_name', 'driver_first_name', 'client_first_name'])
    let lastName = getCsvValue(row, ['last_name', 'driver_last_name', 'client_last_name'])
    if ((!firstName || !lastName) && driverName) {
      const split = splitDriverName(driverName)
      firstName = firstName || split.firstName
      lastName = lastName || split.lastName
    }

    if (!state && !citationNumber) {
      skipped += 1
      continue
    }

    processed += 1

    const requestedFleetId = parseUuidOrNull(getCsvValue(row, ['fleet_id']))
    const requestedAgencyId = parseUuidOrNull(getCsvValue(row, ['agency_id']))
    let fleetId = requestedFleetId
    let agencyId = requestedAgencyId

    if (!isStaffRole(role) && requestedFleetId && !accessibleFleetIds.has(requestedFleetId)) {
      failed += 1
      errors.push(`Line ${lineNumber}: selected fleet is outside your current scope.`)
      continue
    }

    if (role === 'FLEET') {
      fleetId = scope.fleetId
      agencyId = scope.agencyId
    } else if (isAgencyRole(role)) {
      agencyId = scope.agencyId
      fleetId = requestedFleetId && accessibleFleetIds.has(requestedFleetId) ? requestedFleetId : null
    } else if (requestedFleetId && !agencyId) {
      const fleetRes = await supabase
        .from('fleets')
        .select('agency_id')
        .eq('id', requestedFleetId)
        .maybeSingle<{ agency_id: string | null }>()
      agencyId = fleetRes.data?.agency_id ?? agencyId
    }

    const driverId = parseUuidOrNull(getCsvValue(row, ['driver_id']))
    const ownerId = isStaffRole(role) ? parseUuidOrNull(getCsvValue(row, ['owner_id', 'user_id'])) ?? user.id : user.id
    const attorneyFirmId = isStaffRole(role)
      ? parseUuidOrNull(getCsvValue(row, ['attorney_firm_id', 'firm_id']))
      : null
    const assignedAttorneyUserId = isStaffRole(role)
      ? parseUuidOrNull(getCsvValue(row, ['assigned_attorney_user_id', 'attorney_user_id']))
      : null

    const payload: Record<string, unknown> = {
      owner_id: ownerId,
      user_id: ownerId,
      created_by: user.id,
      driver_id: driverId,
      agency_id: agencyId,
      fleet_id: fleetId,
      attorney_firm_id: attorneyFirmId,
      assigned_attorney_user_id: assignedAttorneyUserId,
      submitter_email: user.email ?? null,
      submitter_user_id: user.id,
      state: state || null,
      county: county || null,
      citation_number: citationNumber || null,
      violation_code: violationCode || null,
      violation_date: violationDate,
      court_name: courtName || null,
      court_address: courtAddress || null,
      court_time: courtTime || null,
      court_date: courtDate,
      court_case_number: courtCaseNumber || null,
      status,
      notes: notes || null,
      metadata: {
        first_name: firstName || null,
        last_name: lastName || null,
        driver_name: driverName || `${firstName} ${lastName}`.trim() || null,
        court_case_number: courtCaseNumber || null,
        violation_date: violationDate,
        case_source: 'CSV_IMPORT',
        submitted_via: 'CASE_CSV_IMPORT',
        submitted_by_role: role,
        submitted_by_user_id: user.id,
      },
    }

    const insertError = await insertCaseSafe(supabase, payload, { driverId })
    if (insertError) {
      failed += 1
      errors.push(`Line ${lineNumber}: ${getSetupHint(insertError)}`)
      continue
    }

    imported += 1
  }

  revalidatePath('/dashboard')
  revalidatePath('/my-fleets')
  redirect(
    buildReturnPathWithMessage(
      returnPath,
      [
        'Case CSV import complete.',
        `Processed ${processed} row(s), imported ${imported}, skipped ${skipped}, failed ${failed}.`,
        errors.length ? `First error: ${errors[0]}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    )
  )
}

export async function createFleet(formData: FormData) {
  const companyName = String(formData.get('company_name') ?? '').trim()
  const contactName = String(formData.get('contact_name') ?? '').trim()
  const address = String(formData.get('address') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const returnPath = getReturnPath(formData, '/dashboard')

  if (!companyName) {
    redirect(`${returnPath}?message=Fleet%20company%20name%20is%20required.`)
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!roleCanCreateFleet(role)) {
    redirect(`${returnPath}?message=You%20do%20not%20have%20permission%20to%20create%20fleets.`)
  }

  const scope = await resolveScopeForUser(supabase, user.id)
  let agencyId = scope.agencyId
  const requestedAgencyId = String(formData.get('agency_id') ?? '').trim()

  if (requestedAgencyId && isStaffRole(role)) {
    agencyId = requestedAgencyId
  } else if (!isStaffRole(role)) {
    const accessibleAgencyIds = await getAccessibleAgencyIds(supabase, user.id)
    if (accessibleAgencyIds.length > 1 && !requestedAgencyId) {
      redirect(`${returnPath}?message=Select%20which%20agency%20should%20own%20this%20fleet.`)
    }
    if (requestedAgencyId) {
      if (!accessibleAgencyIds.includes(requestedAgencyId)) {
        redirect(`${returnPath}?message=Selected%20agency%20is%20outside%20your%20workspace%20scope.`)
      }
      agencyId = requestedAgencyId
    }
  }

  if (!agencyId && isAgencyRole(role)) {
    const agencyCompanyName = String(formData.get('agency_company_name') ?? '').trim()
    if (!agencyCompanyName) {
      redirect(`${returnPath}?message=Agency%20company%20name%20is%20required%20before%20creating%20your%20first%20fleet.`)
    }
    const agencyCreate = await supabase
      .from('agencies')
      .insert({
        company_name: agencyCompanyName,
        contact_name: contactName || null,
        email: email || null,
        created_by: user.id,
      })
      .select('id')
      .single<{ id: string }>()

    if (agencyCreate.error) {
      redirect(`${returnPath}?message=${encodeURIComponent(getSetupHint(agencyCreate.error.message))}`)
    }

    agencyId = agencyCreate.data.id

    const membershipInsert = await supabase.from('agency_memberships').upsert(
      {
        agency_id: agencyId,
        user_id: user.id,
        role_in_agency: 'agency_admin',
      },
      { onConflict: 'agency_id,user_id' }
    )

    if (membershipInsert.error && !isRelationMissing(membershipInsert.error.message)) {
      redirect(`${returnPath}?message=${encodeURIComponent(getSetupHint(membershipInsert.error.message))}`)
    }
  }

  if (!agencyId) {
    redirect(`${returnPath}?message=No%20agency%20scope%20found.%20Ask%20admin%20to%20link%20your%20account.`)
  }

  const fleetInsert = await supabase
    .from('fleets')
    .insert({
      agency_id: agencyId,
      company_name: companyName,
      contact_name: contactName || null,
      address: address || null,
      phone: phone || null,
      email: email || null,
      created_by: user.id,
    })
    .select('id')
    .single<{ id: string }>()

  if (fleetInsert.error) {
    redirect(`${returnPath}?message=${encodeURIComponent(getSetupHint(fleetInsert.error.message))}`)
  }

  const membershipInsert = await supabase.from('fleet_memberships').upsert(
    {
      fleet_id: fleetInsert.data.id,
      user_id: user.id,
      role_in_fleet: 'fleet_admin',
    },
    { onConflict: 'fleet_id,user_id' }
  )

  if (membershipInsert.error && !isRelationMissing(membershipInsert.error.message)) {
    redirect(`${returnPath}?message=${encodeURIComponent(getSetupHint(membershipInsert.error.message))}`)
  }

  const verifyFleet = await supabase
    .from('fleets')
    .select('id, company_name, agency_id')
    .eq('id', fleetInsert.data.id)
    .maybeSingle<{ id: string; company_name: string; agency_id: string | null }>()

  if (verifyFleet.error || !verifyFleet.data?.id) {
    await writePlatformLog({
      severity: 'ERROR',
      eventType: 'FLEET_CREATE_VERIFY_FAILED',
      source: 'dashboard.actions.createFleet',
      message: verifyFleet.error?.message || 'Fleet row was not readable after creation.',
      actorUserId: user.id,
      requestPath: returnPath,
      metadata: {
        created_fleet_id: fleetInsert.data.id,
        agency_id: agencyId,
        company_name: companyName,
      },
    })
    redirect(
      `${returnPath}?message=Fleet%20creation%20did%20not%20verify.%20Please%20check%20Supabase%20migrations%20and%20try%20again.`
    )
  }

  revalidatePath('/dashboard')
  revalidatePath('/my-fleets')
  revalidatePath('/intake')
  const successQuery = new URLSearchParams({
    message: 'Fleet created successfully.',
    created: fleetInsert.data.id,
  })
  redirect(`${returnPath}?${successQuery.toString()}`)
}

export async function updateFleet(formData: FormData) {
  const fleetId = String(formData.get('fleet_id') ?? '').trim()
  const companyName = String(formData.get('company_name') ?? '').trim()
  const contactName = String(formData.get('contact_name') ?? '').trim()
  const address = String(formData.get('address') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const returnPath = getReturnPath(formData, '/my-fleets')

  if (!fleetId || !companyName) {
    redirect(buildReturnPathWithMessage(returnPath, 'Fleet id and company name are required.'))
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!roleCanCreateFleet(role)) {
    redirect(buildReturnPathWithMessage(returnPath, 'You do not have permission to edit fleets.'))
  }

  const targetFleet = await resolveFleetAssignmentTarget(supabase, user.id, role, fleetId)
  if (targetFleet.error || !targetFleet.fleet) {
    redirect(buildReturnPathWithMessage(returnPath, targetFleet.error || 'Fleet not found.'))
  }

  const update = await supabase
    .from('fleets')
    .update({
      company_name: companyName,
      contact_name: contactName || null,
      address: address || null,
      phone: phone || null,
      email: email || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', fleetId)

  if (update.error) {
    redirect(buildReturnPathWithMessage(returnPath, getSetupHint(update.error.message), { edit: fleetId }))
  }

  revalidatePath('/my-fleets')
  revalidatePath('/dashboard')
  revalidatePath('/intake')
  redirect(buildReturnPathWithMessage(returnPath, 'Fleet info updated successfully.', { edit: fleetId }))
}

function canSendInviteForRole(signedInRole: PlatformRole, targetRole: PlatformRole) {
  if (isStaffRole(signedInRole)) return true
  if (signedInRole === 'AGENCY') return targetRole === 'AGENCY' || targetRole === 'FLEET' || targetRole === 'DRIVER'
  if (signedInRole === 'FLEET') return targetRole === 'FLEET' || targetRole === 'DRIVER'
  return false
}

export async function sendRoleInvite(formData: FormData) {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const targetRole = normalizePlatformRole(String(formData.get('target_role') ?? 'NONE'))
  const returnPath = getReturnPath(formData, '/dashboard')

  if (!email || targetRole === 'NONE') {
    redirect(`${returnPath}?message=Invite%20email%20and%20target%20role%20are%20required.`)
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!roleCanInvite(role) || !canSendInviteForRole(role, targetRole)) {
    redirect(`${returnPath}?message=You%20do%20not%20have%20permission%20to%20invite%20that%20role.`)
  }

  const scope = await resolveScopeForUser(supabase, user.id)
  const requestedAgencyId = String(formData.get('agency_id') ?? '').trim() || null
  const requestedFleetId = String(formData.get('fleet_id') ?? '').trim() || null
  const requestedFirmId = String(formData.get('firm_id') ?? '').trim() || null

  let agencyId = isStaffRole(role) ? requestedAgencyId : scope.agencyId
  let fleetId = isStaffRole(role) ? requestedFleetId : scope.fleetId
  const firmId = isStaffRole(role) ? requestedFirmId : scope.firmId

  if (!isStaffRole(role)) {
    const accessibleAgencyIds = await getAccessibleAgencyIds(supabase, user.id)
    if (accessibleAgencyIds.length > 1 && !requestedAgencyId) {
      redirect(`${returnPath}?message=Select%20which%20agency%20should%20own%20this%20invite.`)
    }
    if (requestedAgencyId) {
      if (!accessibleAgencyIds.includes(requestedAgencyId)) {
        redirect(`${returnPath}?message=Selected%20agency%20is%20outside%20your%20workspace%20scope.`)
      }
      agencyId = requestedAgencyId
    }
  }

  if (!isStaffRole(role) && requestedFleetId) {
    const accessibleFleetIds = await getAccessibleFleetIds(supabase, user.id)
    if (!accessibleFleetIds.includes(requestedFleetId)) {
      redirect(`${returnPath}?message=Selected%20fleet%20is%20outside%20your%20workspace%20scope.`)
    }
    fleetId = requestedFleetId
  }

  if (fleetId && !agencyId) {
    const fleetScope = await supabase
      .from('fleets')
      .select('agency_id')
      .eq('id', fleetId)
      .maybeSingle<{ agency_id: string | null }>()
    if (!fleetScope.error && fleetScope.data?.agency_id) {
      agencyId = fleetScope.data.agency_id
    }
  }

  if (targetRole === 'AGENCY') {
    fleetId = null
  }

  if (targetRole === 'AGENCY' && !agencyId) {
    redirect(`${returnPath}?message=Agency%20scope%20is%20required%20before%20sending%20agency%20invites.`)
  }

  if ((targetRole === 'FLEET' || targetRole === 'DRIVER') && !agencyId && !fleetId) {
    redirect(
      `${returnPath}?message=Invite%20scope%20is%20missing.%20Link%20your%20account%20to%20an%20agency%20or%20fleet%20first.`
    )
  }

  const inviteInsert = await supabase.from('platform_invites').insert({
    email,
    target_role: targetRole,
    agency_id: targetRole === 'AGENCY' || targetRole === 'FLEET' || targetRole === 'DRIVER' ? agencyId : null,
    fleet_id: targetRole === 'FLEET' || targetRole === 'DRIVER' ? fleetId : null,
    firm_id: targetRole === 'ATTORNEY' ? firmId : null,
    invited_by: user.id,
  })

  if (inviteInsert.error) {
    redirect(`${returnPath}?message=${encodeURIComponent(getSetupHint(inviteInsert.error.message))}`)
  }

  const emailDispatch = await sendAuthInviteEmail(supabase, email, targetRole)

  revalidatePath('/dashboard')
  revalidatePath('/my-fleets')
  redirect(
    `${returnPath}?message=${encodeURIComponent(`Invitation created. ${emailDispatch.notice}`)}`
  )
}

export async function offerCaseToAttorney(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const firmId = String(formData.get('firm_id') ?? '').trim()
  const expiresHours = Number(String(formData.get('expires_hours') ?? '24').trim())

  if (!caseId || !firmId) {
    redirect('/dashboard?message=Case%20and%20attorney%20firm%20are%20required.')
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!isStaffRole(role) && !isAgencyRole(role)) {
    redirect('/dashboard?message=Only%20agency%20or%20admin%20roles%20can%20offer%20cases%20to%20attorneys.')
  }

  const caseLookup = await supabase.from('cases').select('id').eq('id', caseId).maybeSingle<{ id: string }>()
  if (caseLookup.error || !caseLookup.data) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(caseLookup.error?.message || 'Case not found.'))}`)
  }

  const assignmentInsert = await insertCaseAssignmentCompat(supabase, {
    caseId,
    firmId,
    offeredBy: user.id,
    expiresAt: new Date(Date.now() + Math.max(1, expiresHours) * 3600 * 1000).toISOString(),
  })

  if (!assignmentInsert.ok) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(assignmentInsert.error))}`)
  }

  const caseScopeUpdate = await supabase
    .from('cases')
    .update({
      attorney_firm_id: firmId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseId)

  if (caseScopeUpdate.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(caseScopeUpdate.error.message))}`)
  }

  const transition = await transitionCaseStatus(supabase, {
    caseId,
    toStatus: 'OFFERED_TO_ATTORNEY',
    reason: 'OFFER_CASE_TO_ATTORNEY',
    metadata: { firm_id: firmId },
  })

  if (transition.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(transition.error.message))}`)
  }

  revalidatePath('/dashboard')
  revalidatePath(`/cases/${caseId}`)
  redirect(`/cases/${caseId}?message=Case%20offered%20to%20attorney%20firm.`)
}

export async function acceptCaseOffer(formData: FormData) {
  const assignmentId = String(formData.get('assignment_id') ?? '').trim()

  if (!assignmentId) {
    redirect('/dashboard?message=Missing%20assignment%20id.')
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/dashboard?message=Only%20attorney%20or%20admin%20roles%20can%20accept%20offers.')
  }

  const assignment = await supabase
    .from('case_assignments')
    .select('id, case_id, firm_id, accepted_at, declined_at')
    .eq('id', assignmentId)
    .single<{ id: string; case_id: string; firm_id: string; accepted_at: string | null; declined_at: string | null }>()

  if (assignment.error || !assignment.data) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(assignment.error?.message || 'Offer not found.'))}`)
  }

  if (assignment.data.accepted_at || assignment.data.declined_at) {
    redirect('/dashboard?message=Offer%20already%20processed.')
  }

  const accept = await supabase
    .from('case_assignments')
    .update({
      accepted_at: new Date().toISOString(),
      declined_at: null,
      decline_reason: null,
    })
    .eq('id', assignmentId)

  if (accept.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(accept.error.message))}`)
  }

  const caseScopeUpdate = await supabase
    .from('cases')
    .update({
      attorney_firm_id: assignment.data.firm_id,
      assigned_attorney_user_id: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', assignment.data.case_id)

  if (caseScopeUpdate.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(caseScopeUpdate.error.message))}`)
  }

  const transition = await transitionCaseStatus(supabase, {
    caseId: assignment.data.case_id,
    toStatus: 'ATTORNEY_ACCEPTED',
    reason: 'ATTORNEY_ACCEPTED_CASE_OFFER',
    metadata: { assignment_id: assignmentId, firm_id: assignment.data.firm_id },
  })

  if (transition.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(transition.error.message))}`)
  }

  revalidatePath('/dashboard')
  revalidatePath(`/cases/${assignment.data.case_id}`)
  redirect(`/cases/${assignment.data.case_id}?message=Attorney%20offer%20accepted.`)
}

export async function declineCaseOffer(formData: FormData) {
  const assignmentId = String(formData.get('assignment_id') ?? '').trim()
  const declineReason = String(formData.get('decline_reason') ?? '').trim()

  if (!assignmentId) {
    redirect('/dashboard?message=Missing%20assignment%20id.')
  }

  const supabase = await createClient()
  const { role } = await getCurrentUserAndRole(supabase)

  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/dashboard?message=Only%20attorney%20or%20admin%20roles%20can%20decline%20offers.')
  }

  const assignment = await supabase
    .from('case_assignments')
    .select('id, case_id, accepted_at, declined_at')
    .eq('id', assignmentId)
    .single<{ id: string; case_id: string; accepted_at: string | null; declined_at: string | null }>()

  if (assignment.error || !assignment.data) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(assignment.error?.message || 'Offer not found.'))}`)
  }

  if (assignment.data.accepted_at || assignment.data.declined_at) {
    redirect('/dashboard?message=Offer%20already%20processed.')
  }

  const decline = await supabase
    .from('case_assignments')
    .update({
      declined_at: new Date().toISOString(),
      decline_reason: declineReason || null,
      accepted_at: null,
    })
    .eq('id', assignmentId)

  if (decline.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(decline.error.message))}`)
  }

  const transition = await transitionCaseStatus(supabase, {
    caseId: assignment.data.case_id,
    toStatus: 'ATTORNEY_MATCHING',
    reason: 'ATTORNEY_DECLINED_CASE_OFFER',
    metadata: { assignment_id: assignmentId, decline_reason: declineReason || null },
  })

  if (transition.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(transition.error.message))}`)
  }

  revalidatePath('/dashboard')
  revalidatePath(`/cases/${assignment.data.case_id}`)
  redirect(`/cases/${assignment.data.case_id}?message=Offer%20declined.`)
}

export async function setCaseDisposition(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const outcome = String(formData.get('outcome') ?? '').trim().toUpperCase()
  const allowedOutcomes = new Set(['GUILTY', 'AMENDED', 'DISMISSED', 'OTHER'])

  if (!caseId || !allowedOutcomes.has(outcome)) {
    redirect('/attorney/dashboard?message=Case%20and%20valid%20outcome%20are%20required.')
  }

  const supabase = await createClient()
  const { role } = await getCurrentUserAndRole(supabase)

  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/attorney/dashboard?message=Only%20attorney%20or%20admin%20roles%20can%20close%20cases.')
  }

  const existing = await supabase
    .from('cases')
    .select('metadata')
    .eq('id', caseId)
    .maybeSingle<{ metadata: Record<string, unknown> | null }>()

  const mergedMetadata: Record<string, unknown> = {
    ...(existing.data?.metadata ?? {}),
    disposition_outcome: outcome,
    disposition_closed_at: new Date().toISOString(),
  }

  const caseStatusRes = await supabase.from('cases').select('status').eq('id', caseId).single<{ status: string }>()
  if (caseStatusRes.error || !caseStatusRes.data) {
    redirect(
      `/attorney/dashboard?message=${encodeURIComponent(getSetupHint(caseStatusRes.error?.message || 'Case not found.'))}`
    )
  }

  if (caseStatusRes.data.status !== 'DISPOSITION_RECEIVED') {
    const toDisposition = await transitionCaseStatus(supabase, {
      caseId,
      toStatus: 'DISPOSITION_RECEIVED',
      reason: 'SET_CASE_DISPOSITION',
      metadata: { outcome },
    })

    if (toDisposition.error) {
      redirect(`/attorney/dashboard?message=${encodeURIComponent(getSetupHint(toDisposition.error.message))}`)
    }
  }

  let metadataUpdate = await supabase
    .from('cases')
    .update({
      metadata: mergedMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseId)

  if (metadataUpdate.error && /column .*metadata.* does not exist/i.test(metadataUpdate.error.message)) {
    metadataUpdate = await supabase
      .from('cases')
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId)
  }

  if (metadataUpdate.error) {
    redirect(`/attorney/dashboard?message=${encodeURIComponent(getSetupHint(metadataUpdate.error.message))}`)
  }

  const closeTransition = await transitionCaseStatus(supabase, {
    caseId,
    toStatus: 'CLOSED',
    reason: 'SET_CASE_DISPOSITION',
    metadata: { outcome },
  })

  if (closeTransition.error) {
    redirect(`/attorney/dashboard?message=${encodeURIComponent(getSetupHint(closeTransition.error.message))}`)
  }

  revalidatePath('/attorney/dashboard')
  revalidatePath('/dashboard')
  revalidatePath(`/cases/${caseId}`)
  redirect('/attorney/dashboard?message=Case%20closed%20and%20disposition%20saved.')
}

export async function requestCasePayment(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const source = String(formData.get('source') ?? 'CDL_PROTECT')
    .trim()
    .toUpperCase()
  const notes = String(formData.get('notes') ?? '').trim()
  const amountRaw = String(formData.get('amount') ?? '').trim()
  const amount = Number.parseFloat(amountRaw)
  const createCheckout = String(formData.get('create_checkout') ?? '').trim() === '1'

  if (!caseId) {
    redirect('/attorney/dashboard?message=Case%20id%20is%20required%20for%20payment%20requests.')
  }

  if (source !== 'CDL_PROTECT' && source !== 'DIRECT_CLIENT') {
    redirect('/attorney/dashboard?message=Invalid%20payment%20source.')
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/attorney/dashboard?message=Only%20attorney%20or%20admin%20roles%20can%20request%20payments.')
  }

  const amountValue = Number.isFinite(amount) ? Math.max(0, amount) : null
  if (amountValue === null || amountValue <= 0) {
    redirect(`/attorney/dashboard?case=${encodeURIComponent(caseId)}&message=Payment%20amount%20must%20be%20greater%20than%200.`)
  }
  const amountCents = Math.round(amountValue * 100)

  const caseLookup = await supabase
    .from('cases')
    .select('id, citation_number')
    .eq('id', caseId)
    .maybeSingle<{ id: string; citation_number: string | null }>()
  if (caseLookup.error || !caseLookup.data) {
    redirect(`/attorney/dashboard?case=${encodeURIComponent(caseId)}&message=${encodeURIComponent(getSetupHint(caseLookup.error?.message || 'Case not found.'))}`)
  }

  const paymentRequestInsert = await supabase
    .from('payment_requests')
    .insert({
      case_id: caseId,
      requested_by: user.id,
      payer_role: source === 'CDL_PROTECT' ? 'OPS' : 'DRIVER',
      source,
      amount_cents: amountCents,
      currency: 'usd',
      status: 'OPEN',
      due_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      metadata: {
        notes: notes || null,
        requested_from_role: source === 'CDL_PROTECT' ? 'OPS' : 'DRIVER',
      },
    })
    .select('id')
    .single<{ id: string }>()

  if (paymentRequestInsert.error) {
    redirect(
      `/attorney/dashboard?case=${encodeURIComponent(caseId)}&message=${encodeURIComponent(
        getSetupHint(paymentRequestInsert.error.message)
      )}`
    )
  }
  const paymentRequestId = paymentRequestInsert.data.id

  let checkoutUrl: string | null = null
  let checkoutNotice = ''
  if (createCheckout && source === 'DIRECT_CLIENT') {
    if (!isStripeConfigured()) {
      checkoutNotice = ' Stripe checkout was not generated because Stripe is not configured.'
    } else {
      const baseUrl = getAppBaseUrl()
      if (!baseUrl) {
        checkoutNotice = ' Stripe checkout was not generated because app base URL is not configured.'
      } else {
        const query = new URLSearchParams({
          case: caseId,
          message: 'Payment checkout completed. Awaiting settlement webhook.',
        })
        const cancelQuery = new URLSearchParams({
          case: caseId,
          message: 'Payment checkout was cancelled.',
        })
        const session = await createStripeCheckoutSession({
          paymentRequestId,
          caseId,
          amountCents,
          currency: 'usd',
          description: `Traffic ticket payment${caseLookup.data.citation_number ? ` (${caseLookup.data.citation_number})` : ''}`,
          successUrl: `${baseUrl}/attorney/dashboard?${query.toString()}`,
          cancelUrl: `${baseUrl}/attorney/dashboard?${cancelQuery.toString()}`,
        })

        if (session.ok) {
          checkoutUrl = session.url
          const statusUpdate = await supabase
            .from('payment_requests')
            .update({
              status: 'PENDING_CHECKOUT',
              provider: 'STRIPE',
              provider_checkout_session_id: session.id,
              metadata: {
                notes: notes || null,
                requested_from_role: 'DRIVER',
                checkout_url: session.url,
              },
            })
            .eq('id', paymentRequestId)
          if (statusUpdate.error) {
            checkoutNotice = ` Stripe checkout created but status sync failed: ${getSetupHint(statusUpdate.error.message)}`
          } else {
            checkoutNotice = session.url
              ? ' Stripe checkout link generated and attached to this case.'
              : ' Stripe checkout session created.'
          }
        } else {
          checkoutNotice = ` Stripe checkout failed: ${session.error}`
        }
      }
    }
  }

  const targetRole = source === 'CDL_PROTECT' ? 'OPS' : 'DRIVER'
  const instructionParts = [
    source === 'CDL_PROTECT' ? 'Payment request to CDL Protect.' : 'Payment request to direct client.',
    `Amount: $${amountValue.toFixed(2)}`,
    notes || '',
    `Payment request id: ${paymentRequestId}.`,
    checkoutUrl ? `Checkout URL: ${checkoutUrl}` : '',
  ].filter(Boolean)

  const insertTask = await supabase.from('case_tasks').insert({
    case_id: caseId,
    task_type: 'PAYMENT_REQUEST',
    requested_by_user_id: user.id,
    target_role: targetRole,
    instructions: instructionParts.join(' '),
    status: 'OPEN',
    metadata: {
      source,
      amount: amountValue,
      amount_cents: amountCents,
      payment_request_id: paymentRequestId,
      requested_at: new Date().toISOString(),
      lawpay_recommended: source === 'CDL_PROTECT',
      checkout_url: checkoutUrl,
    },
  })

  if (insertTask.error) {
    redirect(
      `/attorney/dashboard?case=${encodeURIComponent(caseId)}&message=${encodeURIComponent(getSetupHint(insertTask.error.message))}`
    )
  }

  const paymentMessage =
    source === 'CDL_PROTECT'
      ? `Payment requested from CDL Protect for $${amountValue.toFixed(2)}. ${notes}`
      : `Payment requested from direct client for $${amountValue.toFixed(2)}. ${notes}`

  await supabase.from('case_messages').insert({
    case_id: caseId,
    sender_user_id: user.id,
    recipient_role: targetRole,
    body: `${paymentMessage.trim()} Payment request id: ${paymentRequestId}.${checkoutUrl ? ` Stripe checkout link: ${checkoutUrl}` : ''}`,
  })

  revalidatePath('/attorney/dashboard')
  revalidatePath('/dashboard')
  revalidatePath(`/cases/${caseId}`)
  redirect(
    `/attorney/dashboard?case=${encodeURIComponent(caseId)}&message=${encodeURIComponent(
      `Payment request created.${checkoutNotice}`
    )}`
  )
}

export async function archiveFleet(formData: FormData) {
  const fleetId = String(formData.get('fleet_id') ?? '').trim()
  if (!fleetId) {
    redirect('/my-fleets?message=Fleet%20id%20is%20required.')
  }

  const supabase = await createClient()
  const { role } = await getCurrentUserAndRole(supabase)
  if (!roleCanCreateFleet(role)) {
    redirect('/my-fleets?message=You%20do%20not%20have%20permission%20to%20archive%20fleets.')
  }

  const update = await supabase
    .from('fleets')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', fleetId)

  if (update.error) {
    redirect(`/my-fleets?message=${encodeURIComponent(getSetupHint(update.error.message))}`)
  }

  revalidatePath('/my-fleets')
  revalidatePath('/dashboard')
  revalidatePath('/intake')
  redirect('/my-fleets?message=Fleet%20archived%20successfully.')
}

export async function markWorkspaceNotificationRead(formData: FormData) {
  const notificationId = String(formData.get('notification_id') ?? '').trim()
  const markAll = String(formData.get('mark_all') ?? '').trim() === '1'
  const returnPath = getReturnPath(formData, '/notifications#notification-inbox')

  if (!notificationId && !markAll) {
    redirect(buildReturnPathWithMessage(returnPath, 'Notification id is required.'))
  }

  const supabase = await createClient()
  const { user } = await getCurrentUserAndRole(supabase)
  const readAt = new Date().toISOString()
  const update = markAll
    ? await supabase
        .from('in_app_notifications')
        .update({ read_at: readAt, updated_at: readAt })
        .eq('user_id', user.id)
        .is('read_at', null)
    : await supabase
        .from('in_app_notifications')
        .update({ read_at: readAt, updated_at: readAt })
        .eq('id', notificationId)
        .eq('user_id', user.id)

  if (update.error) {
    redirect(buildReturnPathWithMessage(returnPath, getSetupHint(update.error.message)))
  }

  revalidatePath('/notifications')
  redirect(buildReturnPathWithMessage(returnPath, markAll ? 'Notifications marked read.' : 'Notification marked read.'))
}

export async function assignCaseToFleet(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const fleetId = String(formData.get('fleet_id') ?? '').trim()
  if (!caseId || !fleetId) {
    redirect('/dashboard?message=Case%20id%20and%20fleet%20id%20are%20required.')
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!isStaffRole(role) && !isAgencyRole(role) && role !== 'FLEET') {
    redirect('/dashboard?message=You%20do%20not%20have%20permission%20to%20assign%20case%20fleet.')
  }

  const targetFleet = await resolveFleetAssignmentTarget(supabase, user.id, role, fleetId)
  if (targetFleet.error || !targetFleet.fleet) {
    redirect(`/dashboard?message=${encodeURIComponent(targetFleet.error || 'Fleet not found.')}`)
  }

  const accessibleCase = await supabase.from('cases').select('id').eq('id', caseId).maybeSingle<{ id: string }>()
  if (accessibleCase.error || !accessibleCase.data?.id) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(accessibleCase.error?.message || 'Case not found.'))}`)
  }

  const update = await supabase
    .from('cases')
    .update({
      fleet_id: fleetId,
      agency_id: targetFleet.fleet.agency_id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseId)

  if (update.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(update.error.message))}`)
  }

  revalidatePath('/dashboard')
  revalidatePath('/my-fleets')
  revalidatePath(`/cases/${caseId}`)
  redirect(`/dashboard?case=${encodeURIComponent(caseId)}&message=Case%20assigned%20to%20fleet%20successfully.`)
}

export async function bulkAssignCasesToFleet(formData: FormData) {
  const caseIds = uniqueIds(formData.getAll('case_ids'))
  const fleetId = String(formData.get('fleet_id') ?? '').trim()
  const returnPath = getReturnPath(formData, '/dashboard#case-queue')

  if (!caseIds.length || !fleetId) {
    redirect(buildReturnPathWithMessage(returnPath, 'Select at least one case and a target fleet.'))
  }

  const supabase = await createClient()
  const { user, role } = await getCurrentUserAndRole(supabase)

  if (!isStaffRole(role) && !isAgencyRole(role) && role !== 'FLEET') {
    redirect('/dashboard?message=You%20do%20not%20have%20permission%20to%20move%20cases%20between%20fleets.')
  }

  const targetFleet = await resolveFleetAssignmentTarget(supabase, user.id, role, fleetId)
  if (targetFleet.error || !targetFleet.fleet) {
    redirect(`/dashboard?message=${encodeURIComponent(targetFleet.error || 'Fleet not found.')}`)
  }

  const accessibleCases = await supabase.from('cases').select('id').in('id', caseIds)
  if (accessibleCases.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(accessibleCases.error.message))}`)
  }

  const accessibleCaseIds = [...new Set((accessibleCases.data ?? []).map((row) => row.id).filter(Boolean))]
  if (!accessibleCaseIds.length) {
    redirect('/dashboard?message=No%20selected%20cases%20were%20available%20in%20your%20current%20scope.')
  }

  const update = await supabase
    .from('cases')
    .update({
      fleet_id: fleetId,
      agency_id: targetFleet.fleet.agency_id,
      updated_at: new Date().toISOString(),
    })
    .in('id', accessibleCaseIds)

  if (update.error) {
    redirect(`/dashboard?message=${encodeURIComponent(getSetupHint(update.error.message))}`)
  }

  revalidatePath('/dashboard')
  revalidatePath('/my-fleets')
  for (const caseId of accessibleCaseIds.slice(0, 25)) {
    revalidatePath(`/cases/${caseId}`)
  }

  redirect(
    buildReturnPathWithMessage(
      returnPath,
      `${accessibleCaseIds.length} case${accessibleCaseIds.length === 1 ? '' : 's'} moved to ${
        targetFleet.fleet.company_name ?? 'the selected fleet'
      }.`,
      { fleet: fleetId, case: null }
    )
  )
}
