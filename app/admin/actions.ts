'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isValidCaseStatus } from '@/app/lib/case-status'
import { PLATFORM_FEATURES, type PlatformFeatureKey } from '@/app/lib/features'
import { isStaffRole, normalizePlatformRole, type PlatformRole } from '@/app/lib/roles'
import { slugifyCustomRole } from '@/app/lib/server/admin-custom-roles'
import { sendAuthInviteEmail } from '@/app/lib/server/invite-email'
import { sendEmail } from '@/app/lib/server/email'
import { writePlatformLog } from '@/app/lib/server/platform-logs'
import { getEnabledFeaturesForRole, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { splitDriverName } from '@/app/lib/server/case-csv'
import { createManualAttorneyMatchForCase, runAttorneyMatchingForCase } from '@/app/lib/matching/attorneyMatching'
import { createClient } from '@/app/lib/supabase/server'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'

type CsvRow = Record<string, string>

type InviteTarget = {
  email: string
  targetRole: PlatformRole
  agencyId?: string | null
  fleetId?: string | null
  firmId?: string | null
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const STATE_NAME_TO_CODE: Record<string, string> = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
  'DISTRICT OF COLUMBIA': 'DC',
}

function getAdminActionHint(message: string) {
  if (/42P17/i.test(message)) {
    return 'Supabase RLS recursion (42P17). Re-run migrations 20260225 and 20260226.'
  }

  if (/invalid input value for enum case_status/i.test(message)) {
    return 'Case status enum mismatch. Re-run migration 20260226_role_based_case_platform.sql.'
  }

  if (/duplicate key value violates unique constraint/i.test(message)) {
    return 'Duplicate entry detected for a unique field.'
  }

  if (/row-level security/i.test(message) || /violates row-level security policy/i.test(message)) {
    return 'Permission denied by RLS policy. Verify your account has ADMIN/OPS/AGENT role.'
  }

  if (/relation .* does not exist/i.test(message) || /schema cache/i.test(message)) {
    return 'Required database objects are missing. Run all Supabase migrations then retry.'
  }

  return message
}

function getMissingColumnName(message: string) {
  const patterns = [
    /column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i,
    /could not find the '([a-zA-Z0-9_]+)' column/i,
  ]

  for (const pattern of patterns) {
    const match = message.match(pattern)
    if (match?.[1]) {
      return match[1]
    }
  }

  return null
}

function normalizeCsvHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function parseCsvRows(rawCsv: string): CsvRow[] {
  const parsed: string[][] = []
  let currentCell = ''
  let currentRow: string[] = []
  let inQuotes = false

  for (let i = 0; i < rawCsv.length; i += 1) {
    const char = rawCsv[i]

    if (char === '"') {
      const nextChar = rawCsv[i + 1]
      if (inQuotes && nextChar === '"') {
        currentCell += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentCell)
      currentCell = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && rawCsv[i + 1] === '\n') {
        i += 1
      }
      currentRow.push(currentCell)
      currentCell = ''
      if (currentRow.some((cell) => cell.trim() !== '')) {
        parsed.push(currentRow)
      }
      currentRow = []
      continue
    }

    currentCell += char
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell)
    if (currentRow.some((cell) => cell.trim() !== '')) {
      parsed.push(currentRow)
    }
  }

  if (!parsed.length) {
    return []
  }

  const headers = parsed[0].map((header, index) => normalizeCsvHeader(header) || `column_${index + 1}`)
  const rows: CsvRow[] = []

  for (const record of parsed.slice(1)) {
    const row: CsvRow = {}
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = String(record[i] ?? '').trim()
    }

    if (Object.values(row).some((value) => value !== '')) {
      rows.push(row)
    }
  }

  return rows
}

function getCsvValue(row: CsvRow, keys: string[]) {
  for (const key of keys) {
    const normalized = normalizeCsvHeader(key)
    const value = String(row[normalized] ?? '').trim()
    if (value) {
      return value
    }
  }

  return ''
}

function parseUuidOrNull(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  return UUID_PATTERN.test(trimmed) ? trimmed : null
}

function parseBooleanOrNull(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (['1', 'true', 'yes', 'y', 'active'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'inactive'].includes(normalized)) return false
  return null
}

function parseDateInput(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed
  }

  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
  const match = trimmed.match(mdy)
  if (match) {
    const month = String(match[1]).padStart(2, '0')
    const day = String(match[2]).padStart(2, '0')
    const year = match[3].length === 2 ? `20${match[3]}` : match[3]
    return `${year}-${month}-${day}`
  }

  const date = new Date(trimmed)
  if (Number.isNaN(+date)) {
    return null
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseCurrencyToCents(value: string) {
  const normalized = value.trim().replace(/[$,\s]/g, '')
  if (!normalized) return 0

  const amount = Number(normalized)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.round(amount * 100)
}

function normalizeStateCode(rawValue: string) {
  const value = rawValue.trim().toUpperCase()
  if (!value) return ''
  if (/^[A-Z]{2}$/.test(value)) return value
  return STATE_NAME_TO_CODE[value] ?? ''
}

function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function getAdminRedirectPath(formData: FormData, fallback = '/admin/dashboard') {
  const value = String(formData.get('redirect_to') ?? '').trim()
  if (value.startsWith('/admin/') || value.startsWith('/cases/')) {
    return value
  }
  return fallback
}

function appendMessageToRedirectPath(path: string, message: string) {
  const [pathWithoutHash, hash = ''] = path.split('#', 2)
  const [pathname, query = ''] = pathWithoutHash.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('message', message)
  const nextQuery = params.toString()
  return `${pathname}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`
}

function getBaseUrl() {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.SITE_URL,
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_VERCEL_URL,
    process.env.VERCEL_URL,
    process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null,
  ]

  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim()
    if (!raw) continue

    let normalized = raw
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = /^localhost(?::\d+)?$/i.test(normalized) ? `http://${normalized}` : `https://${normalized}`
    }

    try {
      return new URL(normalized).toString()
    } catch {
      continue
    }
  }

  return null
}

function parseCapabilityCodes(rawValue: string) {
  return [...new Set(rawValue.split(/[,\n;]/).map((item) => slugifyCustomRole(item)).filter(Boolean))]
}

function parseCountiesValue(raw: string) {
  const value = raw.trim()
  if (!value) {
    return null
  }

  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  const items = value
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean)

  return items.length ? items : null
}

function normalizeCaseStatusValue(rawStatus: string) {
  const status = rawStatus.trim().toUpperCase()
  if (!status) {
    return 'INTAKE_RECEIVED'
  }

  if (isValidCaseStatus(status)) {
    return status
  }

  if (['INTAKE', 'NEW', 'OPEN', 'PENDING'].includes(status)) {
    return 'INTAKE_RECEIVED'
  }
  if (['REVIEW', 'NEEDS_REVIEW'].includes(status)) {
    return 'NEEDS_REVIEW'
  }
  if (['FILED', 'WORKING', 'IN_PROGRESS'].includes(status)) {
    return 'IN_PROGRESS'
  }
  if (['RESOLVED', 'COMPLETE', 'COMPLETED', 'CLOSED'].includes(status)) {
    return 'CLOSED'
  }

  return 'INTAKE_RECEIVED'
}

async function getAdminContext() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/admin/login?message=Please%20sign%20in.')
  }

  const profileById = await supabase
    .from('profiles')
    .select('system_role')
    .eq('id', user.id)
    .maybeSingle<{ system_role: string | null }>()

  const profileByUserId =
    profileById.data ||
    (
      await supabase
        .from('profiles')
        .select('system_role')
        .eq('user_id', user.id)
        .maybeSingle<{ system_role: string | null }>()
    ).data

  const role = normalizePlatformRole(profileByUserId?.system_role)
  if (!isStaffRole(role)) {
    redirect('/dashboard?message=Admin%20portal%20requires%20ADMIN%2C%20OPS%2C%20or%20AGENT%20role.')
  }

  return { supabase, user, role }
}

async function getAdminEnabledFeatures(
  admin: ReturnType<typeof createServiceRoleClient> | Awaited<ReturnType<typeof createClient>>,
  role: PlatformRole
) {
  const featureState = await loadRoleFeatureOverrides(admin)
  return getEnabledFeaturesForRole(role, featureState.overrides)
}

function ensureFeatureEnabledForRole(
  enabledFeatures: readonly string[],
  featureKey: PlatformFeatureKey,
  redirectPath: string
) {
  if (!enabledFeatures.includes(featureKey)) {
    redirect(
      `${redirectPath}?message=${encodeURIComponent(
        `${PLATFORM_FEATURES.find((feature) => feature.key === featureKey)?.label ?? featureKey} is disabled for this role.`
      )}`
    )
  }
}

async function createInviteInternal(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invitedBy: string,
  input: InviteTarget
) {
  const role = input.targetRole
  const payload = {
    email: input.email.toLowerCase(),
    target_role: role,
    agency_id: role === 'AGENCY' || role === 'FLEET' || role === 'DRIVER' ? input.agencyId ?? null : null,
    fleet_id: role === 'FLEET' || role === 'DRIVER' ? input.fleetId ?? null : null,
    firm_id: role === 'ATTORNEY' ? input.firmId ?? null : null,
    invited_by: invitedBy,
  }

  const insert = await supabase.from('platform_invites').insert(payload)
  if (!insert.error) {
    const emailDispatch = await sendAuthInviteEmail(supabase, payload.email, role)
    return {
      ok: true as const,
      duplicate: false,
      message: '',
      emailSent: emailDispatch.sent,
      emailNotice: emailDispatch.notice,
    }
  }

  if (/duplicate key value violates unique constraint/i.test(insert.error.message)) {
    const emailDispatch = await sendAuthInviteEmail(supabase, payload.email, role)
    return {
      ok: true as const,
      duplicate: true,
      message: 'Invite already exists for that email and role.',
      emailSent: emailDispatch.sent,
      emailNotice: emailDispatch.notice,
    }
  }

  return {
    ok: false as const,
    duplicate: false,
    message: getAdminActionHint(insert.error.message),
    emailSent: false,
    emailNotice: '',
  }
}

async function insertCaseWithFallback(
  supabase: Awaited<ReturnType<typeof createClient>>,
  payload: Record<string, unknown>
) {
  const insertPayload = { ...payload }

  while (Object.keys(insertPayload).length > 0) {
    const { error } = await supabase.from('cases').insert(insertPayload)
    if (!error) {
      return null
    }

    if (/invalid input value for enum case_status/i.test(error.message) && 'status' in insertPayload) {
      insertPayload.status = 'INTAKE_RECEIVED'
      continue
    }

    const missingColumn = getMissingColumnName(error.message)
    if (missingColumn && missingColumn in insertPayload) {
      delete insertPayload[missingColumn]
      continue
    }

    return error.message
  }

  return 'No insertable columns were available for this case row.'
}

export async function sendPlatformInvite(formData: FormData) {
  const { supabase, user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const targetRole = normalizePlatformRole(String(formData.get('target_role') ?? 'NONE'))
  const agencyId = parseUuidOrNull(String(formData.get('agency_id') ?? ''))
  const fleetId = parseUuidOrNull(String(formData.get('fleet_id') ?? ''))
  const firmId = parseUuidOrNull(String(formData.get('firm_id') ?? ''))

  if (!email || targetRole === 'NONE') {
    redirect(`${redirectPath}?message=Email%20and%20target%20role%20are%20required.`)
  }

  const invite = await createInviteInternal(supabase, user.id, {
    email,
    targetRole,
    agencyId,
    fleetId,
    firmId,
  })

  if (!invite.ok) {
    redirect(`${redirectPath}?message=${encodeURIComponent(invite.message)}`)
  }

  revalidatePath('/admin/dashboard')
  revalidatePath(redirectPath)
  const summary = [
    invite.duplicate
      ? 'Invite already existed for this email and role.'
      : 'Invite created successfully.',
    invite.emailNotice,
  ]
    .filter(Boolean)
    .join(' ')

  await writePlatformLog({
    severity: 'INFO',
    eventType: 'ADMIN_INVITE_SENT',
    source: 'admin.users',
    message: invite.duplicate ? 'Invite already existed; resend attempted.' : 'Invite created.',
    actorUserId: user.id,
    metadata: {
      email,
      target_role: targetRole,
      duplicate: invite.duplicate,
      email_notice: invite.emailNotice,
    },
  })

  redirect(
    `${redirectPath}?message=${encodeURIComponent(summary)}`
  )
}

export async function removePendingPlatformInvite(formData: FormData) {
  const { supabase, user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const inviteId = parseUuidOrNull(String(formData.get('invite_id') ?? ''))
  if (!inviteId) {
    redirect(`${redirectPath}?message=Invalid%20invite%20id.`)
  }

  const inviteLookup = await supabase
    .from('platform_invites')
    .select('id, email, target_role, accepted_at')
    .eq('id', inviteId)
    .maybeSingle<{ id: string; email: string; target_role: string; accepted_at: string | null }>()

  if (inviteLookup.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(inviteLookup.error.message))}`)
  }

  if (!inviteLookup.data) {
    redirect(`${redirectPath}?message=Invite%20not%20found%20or%20already%20removed.`)
  }

  if (inviteLookup.data.accepted_at) {
    redirect(`${redirectPath}?message=Cannot%20remove%20an%20accepted%20invite.`)
  }

  const deletion = await supabase
    .from('platform_invites')
    .delete()
    .eq('id', inviteId)
    .is('accepted_at', null)

  if (deletion.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(deletion.error.message))}`)
  }

  revalidatePath('/admin/dashboard')
  revalidatePath('/admin/attorney-network')
  revalidatePath(redirectPath)

  await writePlatformLog({
    severity: 'WARN',
    eventType: 'ADMIN_INVITE_REMOVED',
    source: 'admin.users',
    message: 'Pending invite removed.',
    actorUserId: user.id,
    metadata: {
      invite_id: inviteId,
      email: inviteLookup.data.email,
      target_role: inviteLookup.data.target_role,
    },
  })

  redirect(
    `${redirectPath}?message=${encodeURIComponent(
      `Pending invite removed for ${inviteLookup.data.email} (${inviteLookup.data.target_role}). You can resend now. Supabase email rate limits may still apply briefly.`
    )}`
  )
}

export async function createAttorneyAccountInvite(formData: FormData) {
  const { supabase, user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const firmIdInput = parseUuidOrNull(String(formData.get('firm_id') ?? ''))
  const companyName = String(formData.get('company_name') ?? '').trim()
  const contactName = String(formData.get('contact_name') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const phone = String(formData.get('phone') ?? '').trim()
  const state = String(formData.get('state') ?? '').trim()
  const coverageNotes = String(formData.get('coverage_notes') ?? '').trim()
  const countiesRaw = String(formData.get('counties') ?? '').trim()
  const inviteEmail = String(formData.get('invite_email') ?? '')
    .trim()
    .toLowerCase()
  const existingUserId = parseUuidOrNull(String(formData.get('existing_user_id') ?? ''))
  const roleInFirm = String(formData.get('role_in_firm') ?? '').trim() || 'attorney_admin'
  const isActive = parseBooleanOrNull(String(formData.get('is_active') ?? ''))

  if (!firmIdInput && !companyName) {
    redirect(`${redirectPath}?message=Provide%20a%20firm%20ID%20or%20company%20name.`)
  }

  let firmId = firmIdInput
  if (!firmId && companyName) {
    const existing = await supabase
      .from('attorney_firms')
      .select('id')
      .ilike('company_name', companyName)
      .order('created_at', { ascending: true })
      .limit(1)

    if (existing.error) {
      redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(existing.error.message))}`)
    }

    if (existing.data?.length) {
      firmId = String(existing.data[0].id)
    }
  }

  const counties = parseCountiesValue(countiesRaw)
  const patch: Record<string, unknown> = {}
  if (companyName) patch.company_name = companyName
  if (contactName) patch.contact_name = contactName
  if (email) patch.email = email
  if (phone) patch.phone = phone
  if (state) patch.state = state
  if (coverageNotes) patch.coverage_notes = coverageNotes
  if (counties !== null) patch.counties = counties
  if (isActive !== null) patch.is_active = isActive

  if (firmId) {
    if (Object.keys(patch).length) {
      const update = await supabase.from('attorney_firms').update(patch).eq('id', firmId)
      if (update.error) {
        redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(update.error.message))}`)
      }
    }
  } else {
    const insertPayload: Record<string, unknown> = {
      company_name: companyName,
      created_by: user.id,
      ...patch,
    }

    const created = await supabase
      .from('attorney_firms')
      .insert(insertPayload)
      .select('id')
      .single<{ id: string }>()

    if (created.error) {
      redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(created.error.message))}`)
    }

    firmId = created.data.id
  }

  let membershipMessage = ''
  if (existingUserId && firmId) {
    const membership = await supabase
      .from('attorney_firm_memberships')
      .upsert(
        {
          firm_id: firmId,
          user_id: existingUserId,
          role_in_firm: roleInFirm,
        },
        { onConflict: 'firm_id,user_id' }
      )

    if (membership.error) {
      redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(membership.error.message))}`)
    }
    membershipMessage = ' Membership linked.'
  }

  let inviteMessage = ''
  if (inviteEmail && firmId) {
    const invite = await createInviteInternal(supabase, user.id, {
      email: inviteEmail,
      targetRole: 'ATTORNEY',
      firmId,
    })

    if (!invite.ok) {
      redirect(`${redirectPath}?message=${encodeURIComponent(invite.message)}`)
    }

    inviteMessage = invite.duplicate
      ? ' Invite already existed.'
      : ' Invite created.'

    if (invite.emailNotice) {
      inviteMessage += ` ${invite.emailNotice}`
    }
  }

  revalidatePath('/admin/dashboard')
  revalidatePath(redirectPath)
  redirect(
    `${redirectPath}?message=${encodeURIComponent(
      `Attorney firm saved.${membershipMessage}${inviteMessage}`.trim()
    )}`
  )
}

export async function toggleAttorneyFirmActive(formData: FormData) {
  const { supabase } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const firmId = parseUuidOrNull(String(formData.get('firm_id') ?? ''))
  const activate = String(formData.get('activate') ?? '').trim().toLowerCase() === 'true'

  if (!firmId) {
    redirect(`${redirectPath}?message=Invalid%20firm%20id.`)
  }

  const update = await supabase
    .from('attorney_firms')
    .update({ is_active: activate, updated_at: new Date().toISOString() })
    .eq('id', firmId)

  if (update.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(update.error.message))}`)
  }

  revalidatePath('/admin/dashboard')
  revalidatePath(redirectPath)
  redirect(
    `${redirectPath}?message=${encodeURIComponent(
      activate ? 'Attorney firm activated.' : 'Attorney firm deactivated.'
    )}`
  )
}

export async function adminRunAttorneyMatching(formData: FormData) {
  const { user, role } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/cases')
  const admin = createServiceRoleClient()
  const enabledFeatures = await getAdminEnabledFeatures(admin, role)
  ensureFeatureEnabledForRole(enabledFeatures, 'attorney_matching_auto', redirectPath)

  const caseId = parseUuidOrNull(String(formData.get('case_id') ?? ''))
  if (!caseId) {
    redirect(`${redirectPath}?message=Valid%20case%20id%20is%20required.`)
  }

  const matching = await runAttorneyMatchingForCase({
    caseId,
    actorUserId: user.id,
  })

  if (!matching.ok) {
    redirect(`${redirectPath}?message=${encodeURIComponent(matching.message)}`)
  }

  await writePlatformLog({
    severity: 'INFO',
    eventType: 'ADMIN_ATTORNEY_MATCHING_RUN',
    source: 'admin.cases',
    message: `Attorney matching run completed with ${matching.mode}.`,
    actorUserId: user.id,
    metadata: {
      case_id: caseId,
      mode: matching.mode,
      quote_id: 'quoteId' in matching ? matching.quoteId ?? null : null,
      message: matching.message,
    },
  })

  revalidatePath('/admin/cases')
  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')

  redirect(appendMessageToRedirectPath(redirectPath, `Automatic attorney matching completed: ${matching.message}`))
}

export async function adminCreateManualAttorneyMatch(formData: FormData) {
  const { user, role } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/cases')
  const admin = createServiceRoleClient()
  const enabledFeatures = await getAdminEnabledFeatures(admin, role)
  ensureFeatureEnabledForRole(enabledFeatures, 'attorney_matching_manual', redirectPath)

  const caseId = parseUuidOrNull(String(formData.get('case_id') ?? ''))
  const firmId = parseUuidOrNull(String(formData.get('firm_id') ?? ''))
  const feeCentsInput = Number(String(formData.get('attorney_fee_cents') ?? '').trim())
  const feeDollarsInput = String(formData.get('attorney_fee_dollars') ?? '')
  const attorneyFeeCents =
    Number.isFinite(feeCentsInput) && feeCentsInput > 0 ? Math.round(feeCentsInput) : parseCurrencyToCents(feeDollarsInput)

  if (!caseId || !firmId) {
    redirect(`${redirectPath}?message=Case%20and%20attorney%20firm%20are%20required.`)
  }

  if (!attorneyFeeCents) {
    redirect(`${redirectPath}?message=Attorney%20fee%20must%20be%20greater%20than%20zero.`)
  }

  const manualMatch = await createManualAttorneyMatchForCase({
    caseId,
    firmId,
    attorneyFeeCents,
    actorUserId: user.id,
  })

  if (!manualMatch.ok) {
    redirect(`${redirectPath}?message=${encodeURIComponent(manualMatch.message)}`)
  }

  await writePlatformLog({
    severity: 'INFO',
    eventType: 'ADMIN_MANUAL_ATTORNEY_MATCH_CREATED',
    source: 'admin.cases',
    message: manualMatch.reused ? 'Admin reused an existing attorney quote.' : 'Admin created a manual attorney quote.',
    actorUserId: user.id,
    metadata: {
      case_id: caseId,
      firm_id: firmId,
      attorney_fee_cents: attorneyFeeCents,
      quote_id: manualMatch.quoteId,
      reused_quote: manualMatch.reused,
    },
  })

  revalidatePath('/admin/cases')
  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')

  redirect(appendMessageToRedirectPath(redirectPath, manualMatch.message))
}

export async function updateCaseAdmin(formData: FormData) {
  const { supabase } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const caseId = parseUuidOrNull(String(formData.get('case_id') ?? ''))
  if (!caseId) {
    redirect(`${redirectPath}?message=Invalid%20case%20id.`)
  }

  const state = String(formData.get('state') ?? '').trim().toUpperCase()
  const county = String(formData.get('county') ?? '').trim()
  const citationNumber = String(formData.get('citation_number') ?? '').trim()
  const violationCode = String(formData.get('violation_code') ?? '').trim()
  const violationDate = parseDateInput(String(formData.get('violation_date') ?? ''))
  const courtDate = parseDateInput(String(formData.get('court_date') ?? ''))
  const courtCaseNumber = String(formData.get('court_case_number') ?? '').trim()
  const rawStatus = String(formData.get('status') ?? '').trim().toUpperCase()
  const status = rawStatus && isValidCaseStatus(rawStatus) ? rawStatus : normalizeCaseStatusValue(rawStatus)
  const notes = String(formData.get('notes') ?? '').trim()
  const agencyId = parseUuidOrNull(String(formData.get('agency_id') ?? ''))
  const fleetId = parseUuidOrNull(String(formData.get('fleet_id') ?? ''))
  const attorneyFirmId = parseUuidOrNull(String(formData.get('attorney_firm_id') ?? ''))
  const assignedAttorneyUserId = parseUuidOrNull(String(formData.get('assigned_attorney_user_id') ?? ''))
  const driverId = parseUuidOrNull(String(formData.get('driver_id') ?? ''))
  const courtName = String(formData.get('court_name') ?? '').trim()
  const courtAddress = String(formData.get('court_address') ?? '').trim()
  const courtTime = String(formData.get('court_time') ?? '').trim()
  const attorneyUpdateDate = parseDateInput(String(formData.get('attorney_update_date') ?? ''))

  const patch: Record<string, unknown> = {
    state: state || null,
    county: county || null,
    citation_number: citationNumber || null,
    violation_code: violationCode || null,
    violation_date: violationDate,
    court_date: courtDate,
    court_case_number: courtCaseNumber || null,
    status,
    notes: notes || null,
    agency_id: agencyId,
    fleet_id: fleetId,
    attorney_firm_id: attorneyFirmId,
    assigned_attorney_user_id: assignedAttorneyUserId,
    driver_id: driverId,
    court_name: courtName || null,
    court_address: courtAddress || null,
    court_time: courtTime || null,
    attorney_update_date: attorneyUpdateDate,
    updated_at: new Date().toISOString(),
  }

  const update = await supabase.from('cases').update(patch).eq('id', caseId)
  if (update.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(update.error.message))}`)
  }

  revalidatePath('/admin/dashboard')
  revalidatePath(redirectPath)
  revalidatePath('/dashboard')
  revalidatePath(`/cases/${caseId}`)
  redirect(`${redirectPath}?message=Case%20updated.`)
}

export async function deleteCaseAdmin(formData: FormData) {
  const { supabase } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const caseId = parseUuidOrNull(String(formData.get('case_id') ?? ''))
  if (!caseId) {
    redirect(`${redirectPath}?message=Invalid%20case%20id.`)
  }

  const deletion = await supabase.from('cases').delete().eq('id', caseId)
  if (deletion.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(deletion.error.message))}`)
  }

  revalidatePath('/admin/dashboard')
  revalidatePath(redirectPath)
  revalidatePath('/dashboard')
  redirect(`${redirectPath}?message=Case%20deleted.`)
}

export async function importCountyReferenceCsv(formData: FormData) {
  const { supabase, user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const file = formData.get('csv_file')
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${redirectPath}?message=Choose%20a%20CSV%20file%20for%20county%20import.`)
  }

  const csvText = await file.text()
  const rows = parseCsvRows(csvText)
  if (!rows.length) {
    redirect(`${redirectPath}?message=CSV%20file%20did%20not%20contain%20importable%20rows.`)
  }

  let processed = 0
  let skipped = 0
  let failed = 0
  const errors: string[] = []
  const deduped = new Map<string, Record<string, unknown>>()

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const lineNumber = index + 2

    const stateRaw = getCsvValue(row, ['state_code', 'state', 'state_abbreviation', 'state_abbr'])
    const countyRaw = getCsvValue(row, ['county', 'county_name', 'county_display'])
    if (!stateRaw || !countyRaw) {
      skipped += 1
      continue
    }

    const stateCode = normalizeStateCode(stateRaw)
    if (!stateCode) {
      failed += 1
      errors.push(`Line ${lineNumber}: Invalid state value "${stateRaw}".`)
      continue
    }

    const countyName = countyRaw.trim()
    if (!countyName) {
      skipped += 1
      continue
    }

    processed += 1
    const countySlug = getCsvValue(row, ['county_slug']) || slugifyValue(countyName)
    const countyUid = getCsvValue(row, ['county_uid']) || `${stateCode}-${countySlug}`
    const countyDisplay =
      getCsvValue(row, ['county_display']) || `${countyName}, ${stateCode}`

    const key = `${stateCode}|${countyName.toLowerCase()}`
    deduped.set(key, {
      state_code: stateCode,
      county_name: countyName,
      county_display: countyDisplay,
      county_slug: countySlug || null,
      county_uid: countyUid || null,
      created_by: user.id,
    })
  }

  const payloads = [...deduped.values()]
  try {
    const chunkSize = 500
    for (let index = 0; index < payloads.length; index += chunkSize) {
      const chunk = payloads.slice(index, index + chunkSize)
      const upsert = await supabase
        .from('county_reference')
        .upsert(chunk, { onConflict: 'state_code,county_name' })
      if (upsert.error) {
        throw new Error(upsert.error.message)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'County import failed.'
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(message))}`)
  }

  revalidatePath('/admin/dashboard')
  revalidatePath('/admin/attorney-network')
  revalidatePath('/attorney/onboarding')
  revalidatePath('/attorney/my-firm')
  revalidatePath(redirectPath)

  const summary = [
    'County CSV import complete.',
    `Processed ${processed} row(s), skipped ${skipped}, failed ${failed}.`,
    `Upserted ${payloads.length} unique county record(s).`,
    errors.length ? `First error: ${errors[0]}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  redirect(`${redirectPath}?message=${encodeURIComponent(summary)}`)
}

export async function importAttorneyCsv(formData: FormData) {
  const { supabase, user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const file = formData.get('csv_file')
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${redirectPath}?message=Choose%20a%20CSV%20file%20for%20attorney%20import.`)
  }

  const csvText = await file.text()
  const rows = parseCsvRows(csvText)
  if (!rows.length) {
    redirect(`${redirectPath}?message=CSV%20file%20did%20not%20contain%20importable%20rows.`)
  }

  let processed = 0
  let skipped = 0
  let failed = 0
  let firmsCreated = 0
  let firmsUpdated = 0
  let membershipsUpserted = 0
  let invitesCreated = 0
  const errors: string[] = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const lineNumber = index + 2

    const firmIdFromRow = parseUuidOrNull(getCsvValue(row, ['firm_id']))
    const companyNameInput = getCsvValue(row, [
      'company_name',
      'firm_name',
      'law_firm',
      'company',
      'attorney_name',
      'attorney',
    ])
    const contactNameInput = getCsvValue(row, ['contact_name', 'primary_contact', 'attorney_name'])
    const companyName = companyNameInput || contactNameInput
    const contactName = contactNameInput || companyNameInput
    const firmEmail = getCsvValue(row, ['email', 'firm_email', 'attorney_contact_email'])
    const phone = getCsvValue(row, ['phone', 'firm_phone', 'phone_number', 'attorney_contact_phone'])
    const additionalPhone = getCsvValue(row, ['additional_phone'])
    const state = getCsvValue(row, ['state'])
    const counties = parseCountiesValue(
      getCsvValue(row, ['counties', 'county_coverage', 'counties_zip', 'counties___zip'])
    )
    const coverage = getCsvValue(row, ['coverage'])
    const availability = getCsvValue(row, ['availability'])
    const address = getCsvValue(row, ['address'])
    const baseCoverageNotes = getCsvValue(row, ['coverage_notes', 'notes'])
    const coverageNotes = [baseCoverageNotes, coverage, availability, address]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(' | ')
    const isActive = parseBooleanOrNull(getCsvValue(row, ['is_active', 'active', 'availability']))
    const inviteEmail = getCsvValue(row, ['invite_email', 'attorney_email', 'email']).toLowerCase()
    const userId = parseUuidOrNull(getCsvValue(row, ['user_id']))
    const roleInFirm = getCsvValue(row, ['role_in_firm']) || 'member'

    if (!firmIdFromRow && !companyName && !inviteEmail && !userId) {
      skipped += 1
      continue
    }

    processed += 1
    let firmId = firmIdFromRow

    try {
      if (!firmId && companyName) {
        const existing = await supabase
          .from('attorney_firms')
          .select('id')
          .ilike('company_name', companyName)
          .order('created_at', { ascending: true })
          .limit(1)

        if (existing.error) {
          throw new Error(existing.error.message)
        }

        if (existing.data?.length) {
          firmId = String(existing.data[0].id)
        }
      }

      const firmPatch: Record<string, unknown> = {}
      if (companyName) firmPatch.company_name = companyName
      if (contactName) firmPatch.contact_name = contactName
      if (firmEmail) firmPatch.email = firmEmail
      if (phone || additionalPhone) firmPatch.phone = [phone, additionalPhone].filter(Boolean).join(' / ')
      if (state) firmPatch.state = state
      if (coverageNotes) firmPatch.coverage_notes = coverageNotes
      if (counties !== null) firmPatch.counties = counties
      if (isActive !== null) firmPatch.is_active = isActive

      if (firmId) {
        if (Object.keys(firmPatch).length) {
          const update = await supabase.from('attorney_firms').update(firmPatch).eq('id', firmId)
          if (update.error) {
            throw new Error(update.error.message)
          }
          firmsUpdated += 1
        }
      } else {
        if (!companyName) {
          skipped += 1
          continue
        }

        const createPayload = {
          company_name: companyName,
          contact_name: contactName || null,
          email: firmEmail || null,
          phone: [phone, additionalPhone].filter(Boolean).join(' / ') || null,
          state: state || null,
          counties: counties,
          coverage_notes: coverageNotes || null,
          is_active: isActive === null ? true : isActive,
          created_by: user.id,
        }

        const created = await supabase
          .from('attorney_firms')
          .insert(createPayload)
          .select('id')
          .single<{ id: string }>()

        if (created.error) {
          throw new Error(created.error.message)
        }

        firmId = created.data.id
        firmsCreated += 1
      }

      if (firmId && userId) {
        const membership = await supabase
          .from('attorney_firm_memberships')
          .upsert(
            {
              firm_id: firmId,
              user_id: userId,
              role_in_firm: roleInFirm,
            },
            { onConflict: 'firm_id,user_id' }
          )

        if (membership.error) {
          throw new Error(membership.error.message)
        }
        membershipsUpserted += 1
      }

      if (firmId && inviteEmail) {
        const invite = await createInviteInternal(supabase, user.id, {
          email: inviteEmail,
          targetRole: 'ATTORNEY',
          firmId,
        })

        if (!invite.ok) {
          throw new Error(invite.message)
        }

        if (!invite.duplicate) {
          invitesCreated += 1
        }
        if (!invite.emailSent && invite.emailNotice) {
          errors.push(`Line ${lineNumber}: ${invite.emailNotice}`)
        }
      }
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Line ${lineNumber}: ${getAdminActionHint(message)}`)
    }
  }

  revalidatePath('/admin/dashboard')
  revalidatePath(redirectPath)

  const summary = [
    `Attorney CSV import complete.`,
    `Processed ${processed} row(s), skipped ${skipped}, failed ${failed}.`,
    `Firms created ${firmsCreated}, firms updated ${firmsUpdated}.`,
    `Memberships upserted ${membershipsUpserted}, invites created ${invitesCreated}.`,
    errors.length ? `First error: ${errors[0]}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  redirect(`${redirectPath}?message=${encodeURIComponent(summary)}`)
}

export async function importCasesCsv(formData: FormData) {
  const { supabase, user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData)

  const file = formData.get('csv_file')
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${redirectPath}?message=Choose%20a%20CSV%20file%20for%20case%20import.`)
  }

  const csvText = await file.text()
  const rows = parseCsvRows(csvText)
  if (!rows.length) {
    redirect(`${redirectPath}?message=CSV%20file%20did%20not%20contain%20importable%20rows.`)
  }

  let processed = 0
  let skipped = 0
  let failed = 0
  let imported = 0
  const errors: string[] = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const lineNumber = index + 2

    const state = getCsvValue(row, ['state', 'ticket_state']).toUpperCase()
    const citationNumber = getCsvValue(row, ['citation_number', 'citation', 'ticket_number', 'ticket'])
    const county = getCsvValue(row, ['county'])
    const violationCode = getCsvValue(row, ['violation_code', 'violation'])
    const status = normalizeCaseStatusValue(getCsvValue(row, ['status', 'ticket_status', 'ticket_stage']))
    const violationDate = parseDateInput(getCsvValue(row, ['violation_date', 'date_of_violation', 'ticket_violation_date']))
    const courtDate = parseDateInput(getCsvValue(row, ['court_date', 'court_date_ymd']))
    const notes = getCsvValue(row, ['notes', 'intake_notes'])
    const ownerId = parseUuidOrNull(getCsvValue(row, ['owner_id', 'user_id']))
    const driverId = parseUuidOrNull(getCsvValue(row, ['driver_id']))
    const agencyId = parseUuidOrNull(getCsvValue(row, ['agency_id']))
    const fleetId = parseUuidOrNull(getCsvValue(row, ['fleet_id']))
    const attorneyFirmId = parseUuidOrNull(getCsvValue(row, ['attorney_firm_id', 'firm_id']))
    const assignedAttorneyUserId = parseUuidOrNull(getCsvValue(row, ['assigned_attorney_user_id', 'attorney_user_id']))
    const courtName = getCsvValue(row, ['court_name'])
    const courtAddress = getCsvValue(row, ['court_address'])
    const courtTime = getCsvValue(row, ['court_time', 'court_hearing_time', 'court_hearing'])
    const driverName = getCsvValue(row, ['driver_name', 'client_name', 'driver', 'name'])
    let firstName = getCsvValue(row, ['first_name'])
    let lastName = getCsvValue(row, ['last_name'])
    if ((!firstName || !lastName) && driverName) {
      const split = splitDriverName(driverName)
      firstName = firstName || split.firstName
      lastName = lastName || split.lastName
    }
    const attorneyName = getCsvValue(row, ['attorney_name'])
    const attorneyPhone = getCsvValue(row, ['attorney_contact_phone'])
    const attorneyEmail = getCsvValue(row, ['attorney_contact_email'])
    const fleetName = getCsvValue(row, ['fleet_name'])
    const caseReference = getCsvValue(row, ['case_ref', 'court_case_number'])

    if (!state && !citationNumber) {
      skipped += 1
      continue
    }

    processed += 1
    const payload: Record<string, unknown> = {
      owner_id: ownerId ?? user.id,
      state: state || null,
      county: county || null,
      citation_number: citationNumber || null,
      violation_code: violationCode || null,
      violation_date: violationDate,
      court_date: courtDate,
      court_case_number: caseReference || null,
      status,
      notes: notes || null,
      driver_id: driverId,
      agency_id: agencyId,
      fleet_id: fleetId,
      attorney_firm_id: attorneyFirmId,
      assigned_attorney_user_id: assignedAttorneyUserId,
      court_name: courtName || null,
      court_address: courtAddress || null,
      court_time: courtTime || null,
      updated_at: new Date().toISOString(),
    }

    const metadataPatch: Record<string, unknown> = {}
    if (firstName) metadataPatch.first_name = firstName
    if (lastName) metadataPatch.last_name = lastName
    if (driverName) metadataPatch.driver_name = driverName
    if (attorneyName) metadataPatch.attorney_name = attorneyName
    if (attorneyPhone) metadataPatch.attorney_contact_phone = attorneyPhone
    if (attorneyEmail) metadataPatch.attorney_contact_email = attorneyEmail
    if (fleetName) metadataPatch.fleet_name = fleetName
    if (caseReference) {
      metadataPatch.case_ref = caseReference
      metadataPatch.court_case_number = caseReference
    }
    if (violationDate) metadataPatch.violation_date = violationDate

    const metadataRaw = getCsvValue(row, ['metadata'])
    if (metadataRaw) {
      try {
        payload.metadata = { ...metadataPatch, ...JSON.parse(metadataRaw) }
      } catch {
        payload.metadata = { ...metadataPatch, imported_metadata: metadataRaw }
      }
    } else if (Object.keys(metadataPatch).length) {
      payload.metadata = metadataPatch
    }

    const insertError = await insertCaseWithFallback(supabase, payload)
    if (insertError) {
      failed += 1
      errors.push(`Line ${lineNumber}: ${getAdminActionHint(insertError)}`)
      continue
    }

    imported += 1
  }

  revalidatePath('/admin/dashboard')
  revalidatePath(redirectPath)
  revalidatePath('/dashboard')

  const summary = [
    'Case CSV import complete.',
    `Processed ${processed} row(s), imported ${imported}, skipped ${skipped}, failed ${failed}.`,
    errors.length ? `First error: ${errors[0]}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  redirect(`${redirectPath}?message=${encodeURIComponent(summary)}`)
}

export async function adminChangeUserRole(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users')
  const admin = createServiceRoleClient()

  const targetProfileId = parseUuidOrNull(String(formData.get('target_profile_id') ?? ''))
  const targetUserIdInput = parseUuidOrNull(String(formData.get('target_user_id') ?? ''))
  const requestedRole = normalizePlatformRole(String(formData.get('target_role') ?? 'NONE'))

  if (requestedRole === 'NONE') {
    redirect(`${redirectPath}?message=Select%20a%20valid%20role.`)
  }

  if (!targetProfileId && !targetUserIdInput) {
    redirect(`${redirectPath}?message=Target%20user%20or%20profile%20is%20required.`)
  }

  const profileLookup = targetProfileId
    ? await admin
        .from('profiles')
        .select('id, user_id, email, system_role')
        .eq('id', targetProfileId)
        .maybeSingle<{ id: string; user_id: string | null; email: string | null; system_role: string | null }>()
    : await admin
        .from('profiles')
        .select('id, user_id, email, system_role')
        .eq('user_id', targetUserIdInput!)
        .maybeSingle<{ id: string; user_id: string | null; email: string | null; system_role: string | null }>()

  if (profileLookup.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(profileLookup.error.message))}`)
  }

  if (!profileLookup.data) {
    redirect(`${redirectPath}?message=Profile%20not%20found%20for%20the%20selected%20user.`)
  }

  const profile = profileLookup.data
  const targetUserId = profile.user_id || targetUserIdInput || profile.id

  const profileUpdate = await admin
    .from('profiles')
    .update({ system_role: requestedRole, user_id: targetUserId })
    .eq('id', profile.id)
  if (profileUpdate.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(profileUpdate.error.message))}`)
  }

  const authUser = await admin.auth.admin.getUserById(targetUserId)
  if (!authUser.error && authUser.data?.user) {
    const currentMeta = (authUser.data.user.user_metadata ?? {}) as Record<string, unknown>
    await admin.auth.admin.updateUserById(targetUserId, {
      user_metadata: {
        ...currentMeta,
        requested_role: requestedRole,
      },
    })
  }

  await writePlatformLog({
    severity: 'INFO',
    eventType: 'ADMIN_ROLE_CHANGED',
    source: 'admin.users',
    message: `Role updated to ${requestedRole}.`,
    actorUserId: user.id,
    targetUserId,
    metadata: {
      profile_id: profile.id,
      previous_role: profile.system_role,
      next_role: requestedRole,
      target_email: profile.email,
    },
  })

  revalidatePath('/admin/users')
  revalidatePath('/admin/dashboard')
  revalidatePath('/dashboard')
  redirect(`${redirectPath}?message=${encodeURIComponent(`Role updated to ${requestedRole}.`)}`)
}

export async function adminSetUserPassword(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users')
  const admin = createServiceRoleClient()

  const targetUserId = parseUuidOrNull(String(formData.get('target_user_id') ?? ''))
  const password = String(formData.get('new_password') ?? '')
  const confirmPassword = String(formData.get('confirm_password') ?? '')

  if (!targetUserId) {
    redirect(`${redirectPath}?message=Target%20user%20id%20is%20required.`)
  }
  if (password.length < 8) {
    redirect(`${redirectPath}?message=Password%20must%20be%20at%20least%208%20characters.`)
  }
  if (password !== confirmPassword) {
    redirect(`${redirectPath}?message=Password%20confirmation%20does%20not%20match.`)
  }

  const update = await admin.auth.admin.updateUserById(targetUserId, {
    password,
    email_confirm: true,
  })

  if (update.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(update.error.message))}`)
  }

  await writePlatformLog({
    severity: 'WARN',
    eventType: 'ADMIN_PASSWORD_RESET',
    source: 'admin.users',
    message: 'Admin set a new password for a user.',
    actorUserId: user.id,
    targetUserId,
    metadata: {
      action: 'set_password',
    },
  })

  revalidatePath('/admin/users')
  redirect(`${redirectPath}?message=Password%20updated%20successfully.`)
}

export async function adminSendPasswordRecoveryEmail(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users')
  const admin = createServiceRoleClient()

  const targetUserId = parseUuidOrNull(String(formData.get('target_user_id') ?? ''))
  const targetEmail = String(formData.get('target_email') ?? '').trim().toLowerCase()

  if (!targetUserId && !targetEmail) {
    redirect(`${redirectPath}?message=Target%20user%20id%20or%20email%20is%20required.`)
  }

  let resolvedEmail = targetEmail
  const resolvedUserId = targetUserId

  if (resolvedUserId && !resolvedEmail) {
    const authUser = await admin.auth.admin.getUserById(resolvedUserId)
    if (authUser.error || !authUser.data?.user?.email) {
      redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(authUser.error?.message ?? 'User email not found.'))}`)
    }
    resolvedEmail = authUser.data.user.email.toLowerCase()
  }

  const baseUrl = getBaseUrl()
  const recovery = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: resolvedEmail,
    options: baseUrl
      ? {
          redirectTo: `${baseUrl}auth/confirm?next=/settings&set_password=1`,
        }
      : undefined,
  })

  if (recovery.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(recovery.error.message))}`)
  }

  const recoveryLink = recovery.data?.properties?.action_link
  if (!recoveryLink) {
    redirect(`${redirectPath}?message=Supabase%20did%20not%20return%20a%20password%20recovery%20link.`)
  }

  const emailResult = await sendEmail({
    to: [{ email: resolvedEmail }],
    subject: 'Reset your CDL Protect password',
    html: `<p>An administrator requested a password reset for your CDL Protect account.</p><p><a href="${recoveryLink}">Reset your password</a></p><p>If you did not request this change, you can ignore this email.</p>`,
    text: `An administrator requested a password reset for your CDL Protect account. Reset your password here: ${recoveryLink}`,
  })

  if (!emailResult.ok) {
    redirect(`${redirectPath}?message=${encodeURIComponent(emailResult.error)}`)
  }

  await writePlatformLog({
    severity: 'WARN',
    eventType: 'ADMIN_PASSWORD_RECOVERY_LINK_SENT',
    source: 'admin.users',
    message: 'Admin sent a password recovery email.',
    actorUserId: user.id,
    targetUserId: resolvedUserId ?? undefined,
    metadata: {
      email: resolvedEmail,
      fallback_delivery: 'fallback' in emailResult ? emailResult.fallback : false,
    },
  })

  revalidatePath('/admin/users')
  redirect(`${redirectPath}?message=${encodeURIComponent(`Password reset email sent to ${resolvedEmail}.`)}`)
}

type AdminManagedProfileRow = {
  id: string
  user_id: string | null
  email: string | null
  system_role: string | null
  full_name: string | null
}

async function loadAdminManagedProfile(
  admin: ReturnType<typeof createServiceRoleClient>,
  targetProfileId: string | null,
  targetUserIdInput: string | null
) {
  const lookup = targetProfileId
    ? await admin
        .from('profiles')
        .select('id, user_id, email, system_role, full_name')
        .eq('id', targetProfileId)
        .maybeSingle<AdminManagedProfileRow>()
    : await admin
        .from('profiles')
        .select('id, user_id, email, system_role, full_name')
        .eq('user_id', targetUserIdInput!)
        .maybeSingle<AdminManagedProfileRow>()

  if (lookup.error) {
    return { data: null as AdminManagedProfileRow | null, error: lookup.error.message }
  }

  if (!lookup.data) {
    return { data: null as AdminManagedProfileRow | null, error: 'Profile not found for the selected user.' }
  }

  return { data: lookup.data, error: null as string | null }
}

function buildSuspensionMetadata(
  currentMeta: Record<string, unknown>,
  params: {
    suspended: boolean
    actorUserId: string
    nowIso: string
  }
) {
  const nextMeta: Record<string, unknown> = { ...currentMeta }

  if (params.suspended) {
    nextMeta.account_status = 'SUSPENDED'
    nextMeta.suspended_at = params.nowIso
    nextMeta.suspended_by = params.actorUserId
  } else {
    nextMeta.account_status = 'ACTIVE'
    delete nextMeta.suspended_at
    delete nextMeta.suspended_by
  }

  return nextMeta
}

export async function adminSetUserSuspension(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users')
  const admin = createServiceRoleClient()

  const targetProfileId = parseUuidOrNull(String(formData.get('target_profile_id') ?? ''))
  const targetUserIdInput = parseUuidOrNull(String(formData.get('target_user_id') ?? ''))
  const suspend = String(formData.get('suspend') ?? '1').trim() !== '0'
  const banDuration = suspend ? String(formData.get('ban_duration') ?? '876000h').trim() || '876000h' : 'none'

  if (!targetProfileId && !targetUserIdInput) {
    redirect(`${redirectPath}?message=Target%20user%20or%20profile%20is%20required.`)
  }

  const profileLookup = await loadAdminManagedProfile(admin, targetProfileId, targetUserIdInput)
  if (profileLookup.error || !profileLookup.data) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(profileLookup.error || 'Profile not found.'))}`)
  }

  const profile = profileLookup.data
  const targetUserId = profile.user_id || targetUserIdInput || profile.id

  if (targetUserId === user.id) {
    redirect(`${redirectPath}?message=You%20cannot%20suspend%20your%20own%20account%20from%20the%20admin%20portal.`)
  }

  const authUser = await admin.auth.admin.getUserById(targetUserId)
  if (authUser.error || !authUser.data?.user) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(authUser.error?.message || 'Auth user not found.'))}`)
  }

  const nowIso = new Date().toISOString()
  const currentMeta = (authUser.data.user.user_metadata ?? {}) as Record<string, unknown>
  const update = await admin.auth.admin.updateUserById(targetUserId, {
    ban_duration: banDuration,
    user_metadata: buildSuspensionMetadata(currentMeta, {
      suspended: suspend,
      actorUserId: user.id,
      nowIso,
    }),
  })

  if (update.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(update.error.message))}`)
  }

  await writePlatformLog({
    severity: suspend ? 'WARN' : 'INFO',
    eventType: suspend ? 'ADMIN_USER_SUSPENDED' : 'ADMIN_USER_RESTORED',
    source: 'admin.users',
    message: suspend ? 'Admin suspended a user account.' : 'Admin restored a suspended user account.',
    actorUserId: user.id,
    targetUserId,
    metadata: {
      profile_id: profile.id,
      target_email: profile.email,
      target_name: profile.full_name,
      ban_duration: banDuration,
      previous_role: profile.system_role,
    },
  })

  revalidatePath('/admin/users')
  revalidatePath('/admin/dashboard')
  redirect(
    `${redirectPath}?message=${encodeURIComponent(
      suspend ? `User suspended: ${profile.email || targetUserId}.` : `User restored: ${profile.email || targetUserId}.`
    )}`
  )
}

export async function adminDeleteUser(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users')
  const admin = createServiceRoleClient()

  const targetProfileId = parseUuidOrNull(String(formData.get('target_profile_id') ?? ''))
  const targetUserIdInput = parseUuidOrNull(String(formData.get('target_user_id') ?? ''))

  if (!targetProfileId && !targetUserIdInput) {
    redirect(`${redirectPath}?message=Target%20user%20or%20profile%20is%20required.`)
  }

  const profileLookup = await loadAdminManagedProfile(admin, targetProfileId, targetUserIdInput)
  if (profileLookup.error || !profileLookup.data) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(profileLookup.error || 'Profile not found.'))}`)
  }

  const profile = profileLookup.data
  const targetUserId = profile.user_id || targetUserIdInput || profile.id

  if (targetUserId === user.id) {
    redirect(`${redirectPath}?message=You%20cannot%20delete%20your%20own%20account%20from%20the%20admin%20portal.`)
  }

  await writePlatformLog({
    severity: 'WARN',
    eventType: 'ADMIN_USER_DELETED',
    source: 'admin.users',
    message: 'Admin soft-deleted a user account.',
    actorUserId: user.id,
    targetUserId,
    metadata: {
      profile_id: profile.id,
      target_email: profile.email,
      target_name: profile.full_name,
      previous_role: profile.system_role,
      delete_mode: 'soft_auth_delete_with_profile_cleanup',
    },
  })

  const authDelete = await admin.auth.admin.deleteUser(targetUserId, true)
  if (authDelete.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(authDelete.error.message))}`)
  }

  await admin.from('agency_memberships').delete().eq('user_id', targetUserId)
  await admin.from('fleet_memberships').delete().eq('user_id', targetUserId)
  await admin.from('attorney_firm_memberships').delete().eq('user_id', targetUserId)
  await admin.from('drivers').delete().eq('user_id', targetUserId)
  await admin.from('profiles').delete().eq('id', profile.id)

  revalidatePath('/admin/users')
  revalidatePath('/admin/dashboard')
  revalidatePath('/dashboard')
  redirect(`${redirectPath}?message=${encodeURIComponent(`User deleted: ${profile.email || targetUserId}.`)}`)
}

export async function adminCreateCustomRole(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users')
  const admin = createServiceRoleClient()

  const name = String(formData.get('name') ?? '').trim()
  const slugInput = String(formData.get('slug') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim()
  const baseRole = normalizePlatformRole(String(formData.get('base_role') ?? 'NONE'))
  const capabilityCodes = parseCapabilityCodes(String(formData.get('capability_codes') ?? ''))

  if (!name) {
    redirect(`${redirectPath}?message=Custom%20role%20name%20is%20required.`)
  }

  const slug = slugifyCustomRole(slugInput || name)
  if (!slug) {
    redirect(`${redirectPath}?message=Custom%20role%20slug%20is%20required.`)
  }

  const upsert = await admin.from('platform_custom_roles').upsert(
    {
      name,
      slug,
      description: description || null,
      base_role: baseRole === 'NONE' ? null : baseRole,
      capability_codes: capabilityCodes,
      is_active: true,
      created_by: user.id,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'slug' }
  )

  if (upsert.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(upsert.error.message))}`)
  }

  await writePlatformLog({
    severity: 'INFO',
    eventType: 'ADMIN_CUSTOM_ROLE_SAVED',
    source: 'admin.users',
    message: `Custom role saved: ${name}.`,
    actorUserId: user.id,
    metadata: {
      slug,
      base_role: baseRole === 'NONE' ? null : baseRole,
      capability_codes: capabilityCodes,
    },
  })

  revalidatePath('/admin/users')
  redirect(`${redirectPath}?message=${encodeURIComponent(`Custom role ${name} saved.`)}`)
}

export async function adminAssignCustomRole(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users')
  const admin = createServiceRoleClient()

  const profileId = parseUuidOrNull(String(formData.get('target_profile_id') ?? ''))
  const customRoleId = parseUuidOrNull(String(formData.get('custom_role_id') ?? ''))

  if (!profileId || !customRoleId) {
    redirect(`${redirectPath}?message=Profile%20and%20custom%20role%20are%20required.`)
  }

  const upsert = await admin.from('platform_custom_role_assignments').upsert(
    {
      profile_id: profileId,
      custom_role_id: customRoleId,
      assigned_by: user.id,
    },
    { onConflict: 'custom_role_id,profile_id' }
  )

  if (upsert.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(upsert.error.message))}`)
  }

  revalidatePath('/admin/users')
  redirect(`${redirectPath}?message=Custom%20role%20assigned%20successfully.`)
}

export async function adminRemoveCustomRole(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users')
  const admin = createServiceRoleClient()

  const profileId = parseUuidOrNull(String(formData.get('target_profile_id') ?? ''))
  const customRoleId = parseUuidOrNull(String(formData.get('custom_role_id') ?? ''))

  if (!profileId || !customRoleId) {
    redirect(`${redirectPath}?message=Profile%20and%20custom%20role%20are%20required.`)
  }

  const removal = await admin
    .from('platform_custom_role_assignments')
    .delete()
    .eq('profile_id', profileId)
    .eq('custom_role_id', customRoleId)

  if (removal.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(removal.error.message))}`)
  }

  await writePlatformLog({
    severity: 'WARN',
    eventType: 'ADMIN_CUSTOM_ROLE_REMOVED',
    source: 'admin.users',
    message: 'Custom role assignment removed.',
    actorUserId: user.id,
    metadata: {
      profile_id: profileId,
      custom_role_id: customRoleId,
    },
  })

  revalidatePath('/admin/users')
  redirect(`${redirectPath}?message=Custom%20role%20removed.`)
}

export async function adminSaveRoleFeatureAccess(formData: FormData) {
  const { user } = await getAdminContext()
  const redirectPath = getAdminRedirectPath(formData, '/admin/users#role-controls')
  const admin = createServiceRoleClient()

  const targetRole = normalizePlatformRole(String(formData.get('target_role') ?? 'NONE'))
  if (targetRole === 'NONE') {
    redirect(`${redirectPath}?message=Select%20a%20valid%20platform%20role.`)
  }

  const featureState = await loadRoleFeatureOverrides(admin)
  if (featureState.migrationPending) {
    redirect(`${redirectPath}?message=Apply%20the%20latest%20role-feature%20migration%20first.`)
  }
  if (featureState.error) {
    redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(featureState.error))}`)
  }

  const nextEnabledFeatures = new Set<PlatformFeatureKey>()
  for (const feature of PLATFORM_FEATURES) {
    if (String(formData.get(`feature_${feature.key}`) ?? '') === '1') {
      nextEnabledFeatures.add(feature.key)
    }
  }

  for (const feature of PLATFORM_FEATURES) {
    const shouldEnable = nextEnabledFeatures.has(feature.key)
    const isDefaultEnabled = feature.defaultRoles.some((defaultRole) => defaultRole === targetRole)
    const existingOverride = featureState.overrides.find(
      (row) => row.role === targetRole && row.feature_key === feature.key
    )

    if (shouldEnable === isDefaultEnabled) {
      if (existingOverride) {
        const removal = await admin
          .from('platform_role_feature_overrides')
          .delete()
          .eq('id', existingOverride.id)

        if (removal.error) {
          redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(removal.error.message))}`)
        }
      }
      continue
    }

    const upsert = await admin.from('platform_role_feature_overrides').upsert(
      {
        role: targetRole,
        feature_key: feature.key,
        is_enabled: shouldEnable,
        updated_by: user.id,
      },
      { onConflict: 'role,feature_key' }
    )

    if (upsert.error) {
      redirect(`${redirectPath}?message=${encodeURIComponent(getAdminActionHint(upsert.error.message))}`)
    }
  }

  await writePlatformLog({
    severity: 'INFO',
    eventType: 'ADMIN_ROLE_FEATURE_ACCESS_UPDATED',
    source: 'admin.users',
    message: `Role feature access updated for ${targetRole}.`,
    actorUserId: user.id,
    metadata: {
      role: targetRole,
      enabled_features: [...nextEnabledFeatures],
    },
  })

  revalidatePath('/admin/users')
  revalidatePath('/admin/cases')
  revalidatePath('/admin/database')
  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/integrations')
  revalidatePath('/attorney/communications')
  revalidatePath('/attorney/reminders')
  revalidatePath('/attorney/tasks')
  revalidatePath('/attorney/billing')
  revalidatePath('/my-fleets')
  revalidatePath('/intake')
  revalidatePath('/dashboard')
  redirect(`${redirectPath}?message=${encodeURIComponent(`Feature access saved for ${targetRole}.`)}`)
}
