'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getCalendarEventTypeMeta } from '@/app/attorney/calendar/config'
import {
  queueCalendarExportSyncForItem,
  rescheduleReminderJobsForCalendarItem,
} from '@/app/lib/server/attorney-calendar-runtime'
import { createClient } from '@/app/lib/supabase/server'
import {
  ATTORNEY_CASE_STATUSES,
  isValidAttorneyWorkflowStep,
  isValidCaseStatus,
} from '@/app/lib/case-status'
import { buildTicketOcrText, runTicketOcrFromPublicUrl } from '@/app/lib/server/ocr'
import { transitionCaseStatus } from '@/app/lib/server/case-status-transition'
import { sendAuthInviteEmail } from '@/app/lib/server/invite-email'
import { enqueueDocumentOcrJob } from '@/app/lib/server/job-queue'
import { isAttorneyRole, isStaffRole, normalizePlatformRole, type PlatformRole } from '@/app/lib/roles'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const SYNC_OCR_ON_UPLOAD =
  String(process.env.CASE_SYNC_OCR_ON_UPLOAD ?? '').trim() === '1' ||
  String(process.env.OCR_SYNC_FALLBACK_ON_UPLOAD ?? '').trim() === '1'

type QueryClient = Awaited<ReturnType<typeof createClient>>

type AttorneySection = 'management' | 'jury' | 'close' | 'defendant'

type AttorneySectionConfig = {
  textFields: readonly string[]
  dateFields: readonly string[]
  boolFields: readonly string[]
  numberFields: readonly string[]
}

const ATTORNEY_SECTION_CONFIG: Record<AttorneySection, AttorneySectionConfig> = {
  management: {
    textFields: [
      'entry_method',
      'offer_request_method',
      'pending_reason',
      'continuance_reason',
      'continuance_reason_other',
      'interpreter',
      'documents_needed',
      'documents_received',
    ],
    dateFields: ['offer_requested_date', 'offer_delivered_date', 'guilty_plea_date', 'continuance_date'],
    boolFields: ['offer_accepted', 'offer_rejected', 'questions', 'no_court_date', 'appear'],
    numberFields: ['client_meetings_count'],
  },
  jury: {
    textFields: ['interpreter'],
    dateFields: [
      'jury_trial_demand_date',
      'trial_date',
      'trial_setting_date',
      'state_discovery_requested_date',
      'provided_discovery_date',
      'pretrial_conference_date',
      'client_discovery_requested_date',
      'state_discovery_received_date',
      'received_date',
      'cop_depo_date',
    ],
    boolFields: [],
    numberFields: [],
  },
  close: {
    textFields: ['court_fine_payment_check_number', 'fedex_tracking_number'],
    dateFields: ['court_fine_payment_mailed_date', 'fedex_received_date', 'payment_cashed_date'],
    boolFields: ['close_case_in_broker_account'],
    numberFields: [],
  },
  defendant: {
    textFields: ['name', 'phone', 'email', 'birthday', 'note'],
    dateFields: [],
    boolFields: ['has_cdl'],
    numberFields: [],
  },
}

function getReturnTarget(formData: FormData, caseId: string) {
  const raw = String(formData.get('return_to') ?? '').trim()
  if (raw.startsWith('/')) return raw
  return `/cases/${caseId}`
}

function redirectWithMessage(path: string, message: string): never {
  const separator = path.includes('?') ? '&' : '?'
  redirect(`${path}${separator}message=${encodeURIComponent(message)}`)
}

function cleanFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getCaseActionHint(message: string) {
  if (/CASE_STATUS_TRANSITION_BLOCKED|transition to .* is not allowed/i.test(message)) {
    return 'Requested case status transition is blocked by workflow policy for your role or current state.'
  }

  if (/CASE_STATUS_ACCESS_DENIED|Case not found or access denied/i.test(message)) {
    return 'You do not have access to perform this status transition.'
  }

  if (/42P17/i.test(message)) {
    return 'Supabase RLS recursion (42P17). Re-run migrations 20260225 and 20260226.'
  }

  if (/invalid input value for enum .*doc_type/i.test(message)) {
    return 'Document type enum mismatch. Leave type blank or use a valid enum value configured in your DB.'
  }

  if (/invalid input value for enum case_status/i.test(message)) {
    return 'Case status mismatch. Run migration 20260226_role_based_case_platform.sql.'
  }

  if (/infinite recursion detected in policy/i.test(message)) {
    return 'Conflicting legacy RLS policies detected. Run migrations 20260225 and 20260226.'
  }

  if (/column .*owner_id.* does not exist/i.test(message) || /column .*id.* does not exist/i.test(message)) {
    return 'Legacy schema mismatch detected. Run migrations up to 20260226.'
  }

  if (/relation .* does not exist/i.test(message) || /schema cache/i.test(message)) {
    return 'Missing workflow tables. Run migration 20260226_role_based_case_platform.sql.'
  }

  return message
}

function isDocTypeEnumError(message: string) {
  return /invalid input value for enum .*doc_type/i.test(message)
}

function shouldUseSyncOcrFallback(message: string) {
  return /enqueue_case_job/i.test(message) && (/schema cache/i.test(message) || /function/i.test(message))
}

function parseDateToYmd(input: string) {
  const s = String(input || '').trim()
  if (!s) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
  if (mdy.test(s)) {
    const [, mm, dd, yy] = s.match(mdy) ?? []
    const year = yy.length === 2 ? `20${yy}` : yy
    return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  }

  const d = new Date(s)
  if (!Number.isNaN(+d)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  return null
}

function getMissingColumnName(message: string) {
  const match =
    message.match(/column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i) ??
    message.match(/could not find the '([a-zA-Z0-9_]+)' column/i)
  return match?.[1] ?? null
}

function getTodayDateValue() {
  return new Date().toISOString().slice(0, 10)
}

function combineDateTimeToIso(dateValue: string, timeValue: string, fallbackTime = '09:00') {
  const day = parseDateToYmd(dateValue)
  if (!day) return null
  const safeTime = String(timeValue ?? '').trim() || fallbackTime
  const combined = new Date(`${day}T${safeTime}:00`)
  return Number.isNaN(+combined) ? null : combined.toISOString()
}

function parseOptionalNumber(input: string) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return n
}

function parseBool(formData: FormData, field: string) {
  const raw = String(formData.get(field) ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function isAttorneySection(value: string): value is AttorneySection {
  return value === 'management' || value === 'jury' || value === 'close' || value === 'defendant'
}

function isAttorneyExternalCase(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return false

  const source = String(metadata['case_source'] ?? metadata['source'] ?? metadata['intake_source'] ?? '')
    .trim()
    .toUpperCase()
  const submittedByRole = String(metadata['submitted_by_role'] ?? '').trim().toUpperCase()
  const submittedVia = String(metadata['submitted_via'] ?? '').trim().toUpperCase()

  return (
    source.includes('ATTORNEY') ||
    submittedByRole === 'ATTORNEY' ||
    submittedVia.includes('ATTORNEY')
  )
}

async function readCaseMetadataForWriter(
  supabase: Awaited<ReturnType<typeof createClient>>,
  caseId: string
) {
  const existing = await supabase
    .from('cases')
    .select('metadata')
    .eq('id', caseId)
    .single<{ metadata: Record<string, unknown> | null }>()

  return existing
}

async function logCaseEvent(
  caseId: string,
  actorId: string,
  eventType: string,
  eventSummary: string,
  metadata?: Record<string, unknown>
) {
  const supabase = await createClient()
  await supabase.from('case_events').insert({
    case_id: caseId,
    actor_id: actorId,
    event_type: eventType,
    event_summary: eventSummary,
    metadata: metadata ?? null,
  })
}

async function getCurrentUserRole(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const byId = await supabase
    .from('profiles')
    .select('system_role')
    .eq('id', userId)
    .maybeSingle<{ system_role: string | null }>()

  if (!byId.error && byId.data) {
    return normalizePlatformRole(byId.data.system_role)
  }

  const byUserId = await supabase
    .from('profiles')
    .select('system_role')
    .eq('user_id', userId)
    .maybeSingle<{ system_role: string | null }>()

  return normalizePlatformRole(byUserId.data?.system_role)
}

type CaseMonitoringActionRow = {
  id: string
  owner_id: string | null
  submitter_user_id?: string | null
  driver_id?: string | null
  agency_id?: string | null
  fleet_id?: string | null
}

const CASE_MONITORING_SELECT_VARIANTS = [
  'id, owner_id, submitter_user_id, driver_id, agency_id, fleet_id',
  'id, owner_id, submitter_user_id, agency_id, fleet_id',
  'id, owner_id, driver_id, agency_id, fleet_id',
  'id, owner_id, agency_id, fleet_id',
]

async function loadCaseMonitoringActionRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  caseId: string
) {
  let lastError = ''

  for (const selection of CASE_MONITORING_SELECT_VARIANTS) {
    const result = await supabase.from('cases').select(selection).eq('id', caseId).maybeSingle<CaseMonitoringActionRow>()
    if (!result.error && result.data) {
      return { data: result.data, error: null as string | null }
    }

    if (!result.error) continue
    lastError = result.error.message
    if (!/column .* does not exist/i.test(result.error.message) && result.error.code !== 'PGRST204') {
      break
    }
  }

  return { data: null as CaseMonitoringActionRow | null, error: lastError || 'Case not found.' }
}

async function requireDriverCaseMonitoringContext(caseId: string, returnTo: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (role !== 'DRIVER' && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only driver or admin roles can manage fleet monitoring from this case.')
  }

  const caseResult = await loadCaseMonitoringActionRow(supabase, caseId)
  if (caseResult.error || !caseResult.data) {
    redirectWithMessage(returnTo, getCaseActionHint(caseResult.error || 'Case not found.'))
  }

  const caseRow = caseResult.data
  const canManageCase =
    isStaffRole(role) ||
    caseRow.owner_id === user.id ||
    caseRow.submitter_user_id === user.id ||
    caseRow.driver_id === user.id

  if (!canManageCase) {
    redirectWithMessage(returnTo, 'You do not have permission to change fleet monitoring for this case.')
  }

  return { supabase, user, role, caseRow }
}

async function resolveFleetMonitoringTarget(params: {
  admin: ReturnType<typeof createServiceRoleClient>
  userId: string
  role: PlatformRole
  requestedFleetId: string
  currentCaseFleetId: string | null
  returnTo: string
}) {
  const fleetId = params.requestedFleetId || params.currentCaseFleetId || ''
  if (!fleetId) {
    redirectWithMessage(params.returnTo, 'Choose a fleet before sharing this case with fleet monitoring.')
  }

  const fleetResult = await params.admin
    .from('fleets')
    .select('id, company_name, agency_id, is_active')
    .eq('id', fleetId)
    .maybeSingle<{ id: string; company_name: string | null; agency_id: string | null; is_active?: boolean | null }>()

  if (fleetResult.error || !fleetResult.data?.id) {
    redirectWithMessage(params.returnTo, getCaseActionHint(fleetResult.error?.message || 'Fleet not found.'))
  }

  if (fleetResult.data.is_active === false) {
    redirectWithMessage(params.returnTo, 'Archived fleets cannot monitor new or updated cases.')
  }

  if (!isStaffRole(params.role) && fleetId !== params.currentCaseFleetId) {
    const membership = await params.admin
      .from('fleet_memberships')
      .select('fleet_id')
      .eq('user_id', params.userId)
      .eq('fleet_id', fleetId)
      .maybeSingle<{ fleet_id: string }>()

    if (membership.error || !membership.data?.fleet_id) {
      redirectWithMessage(params.returnTo, 'That fleet is outside your current workspace access.')
    }
  }

  return {
    id: fleetResult.data.id,
    companyName: String(fleetResult.data.company_name ?? '').trim() || fleetResult.data.id,
    agencyId: fleetResult.data.agency_id ?? null,
  }
}

function revalidateCaseWorkspacePaths(caseId: string, returnTo: string) {
  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/my-fleets')
  revalidatePath('/settings')
  revalidatePath(returnTo.split('?')[0])
}

async function updateDocumentSafe(supabase: QueryClient, documentId: string, patch: Record<string, unknown>) {
  const payload = { ...patch }

  while (Object.keys(payload).length) {
    const { error } = await supabase.from('documents').update(payload).eq('id', documentId)

    if (!error) return

    if (!/column .* does not exist/i.test(error.message) && error.code !== 'PGRST204') {
      throw new Error(error.message)
    }

    const match = error.message.match(/column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i)
    if (match?.[1] && match[1] in payload) {
      delete payload[match[1]]
      continue
    }

    delete payload.ocr_status
    delete payload.ocr_confidence
    delete payload.ocr_extracted
    delete payload.ocr_payload
  }
}

async function updateCaseRecordSafe(
  supabase: QueryClient,
  caseId: string,
  patch: Record<string, unknown>
) {
  const payload = { ...patch }

  while (Object.keys(payload).length) {
    const { error } = await supabase.from('cases').update(payload).eq('id', caseId)
    if (!error) return null

    if (!/column .* does not exist/i.test(error.message) && error.code !== 'PGRST204') {
      return error.message
    }

    const missingColumn = getMissingColumnName(error.message)
    if (missingColumn && missingColumn in payload) {
      delete payload[missingColumn]
      continue
    }

    if ('metadata' in payload) {
      delete payload.metadata
      continue
    }

    return error.message
  }

  return null
}

async function insertDocumentSafe(
  supabase: QueryClient,
  payload: Record<string, unknown>
) {
  const insertPayload = { ...payload }

  while (true) {
    const { data, error } = await supabase.from('documents').insert(insertPayload).select('id').single<{ id: string }>()

    if (!error) return data.id

    if (isDocTypeEnumError(error.message) && 'doc_type' in insertPayload) {
      delete insertPayload.doc_type
      continue
    }

    if (!/column .* does not exist/i.test(error.message) && error.code !== 'PGRST204') {
      throw new Error(error.message)
    }

    const match = error.message.match(/column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i)
    if (match?.[1] && match[1] in insertPayload) {
      delete insertPayload[match[1]]
      continue
    }

    delete insertPayload.ocr_status
    delete insertPayload.ocr_confidence
    delete insertPayload.ocr_extracted
    delete insertPayload.ocr_payload

    if (!Object.keys(insertPayload).length) {
      throw new Error('Unable to insert document: schema is missing required columns.')
    }
  }
}

async function runDocumentOcrInternal(
  supabase: QueryClient,
  params: { caseId: string; documentId: string; storagePath: string; actorId: string }
) {
  await updateDocumentSafe(supabase, params.documentId, {
    ocr_status: 'PROCESSING',
  })

  const signed = await supabase.storage.from('case-documents').createSignedUrl(params.storagePath, 60 * 20)

  if (signed.error || !signed.data?.signedUrl) {
    await updateDocumentSafe(supabase, params.documentId, {
      ocr_status: 'FAILED',
      ocr_payload: { error: signed.error?.message || 'Could not create signed URL.' },
    })

    return {
      ok: false,
      message: signed.error?.message || 'Could not create signed URL for OCR.',
    }
  }

  const ocr = await runTicketOcrFromPublicUrl(signed.data.signedUrl)

  if (!ocr.ok) {
    await updateDocumentSafe(supabase, params.documentId, {
      ocr_status: 'FAILED',
      ocr_payload: { error: ocr.error || 'OCR failed', raw: ocr.raw },
    })

    await logCaseEvent(params.caseId, params.actorId, 'OCR_FAILED', 'OCR failed for uploaded document.', {
      document_id: params.documentId,
      reason: ocr.error || 'unknown',
    })

    return {
      ok: false,
      message: ocr.error || 'OCR failed for document.',
    }
  }

  await updateDocumentSafe(supabase, params.documentId, {
    ocr_status: 'READY',
    ocr_confidence: ocr.confidence,
    ocr_extracted: ocr.fields,
    ocr_payload: ocr.raw,
  })

  const { data: caseRow } = await supabase
    .from('cases')
    .select('state, citation_number, violation_code, county, court_date, ocr_text')
    .eq('id', params.caseId)
    .single<{
      state: string | null
      citation_number: string | null
      violation_code: string | null
      county: string | null
      court_date: string | null
      ocr_text: string | null
    }>()

  const updates: Record<string, unknown> = {}

  if (caseRow) {
    if (!caseRow.state && ocr.fields.state) updates.state = ocr.fields.state
    if (!caseRow.citation_number && ocr.fields.ticket) updates.citation_number = ocr.fields.ticket
    if (!caseRow.violation_code && (ocr.fields.violationType || ocr.fields.violationTypes)) {
      updates.violation_code = ocr.fields.violationType || ocr.fields.violationTypes
    }
    if (!caseRow.county && ocr.fields.courtCounty) updates.county = ocr.fields.courtCounty
    if (!caseRow.ocr_text) {
      const ocrText = buildTicketOcrText(ocr.fields)
      if (ocrText) updates.ocr_text = ocrText
    }

    const parsedCourtDate = parseDateToYmd(ocr.fields.courtDate)
    if (!caseRow.court_date && parsedCourtDate) updates.court_date = parsedCourtDate
  }

  if (Object.keys(updates).length) {
    await supabase.from('cases').update(updates).eq('id', params.caseId)
  }

  await logCaseEvent(
    params.caseId,
    params.actorId,
    'OCR_COMPLETED',
    'OCR completed for uploaded document.',
    {
      document_id: params.documentId,
      confidence: ocr.confidence,
      extracted: ocr.fields,
    }
  )

  return {
    ok: true,
    message: 'OCR completed successfully.',
  }
}

export async function updateCaseStatus(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const status = String(formData.get('status') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)

  if (!caseId || !isValidCaseStatus(status)) {
    redirectWithMessage(returnTo, 'Invalid status value.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (isAttorneyRole(role) && !ATTORNEY_CASE_STATUSES.includes(status)) {
    redirectWithMessage(returnTo, 'This status is internal-only and not available for attorney updates.')
  }

  const { data: existingCase, error: existingError } = await supabase
    .from('cases')
    .select('status')
    .eq('id', caseId)
    .single<{ status: string }>()

  if (existingError || !existingCase) {
    redirectWithMessage(returnTo, getCaseActionHint(existingError?.message || 'Case not found.'))
  }

  const transition = await transitionCaseStatus(supabase, {
    caseId,
    toStatus: status,
    reason: 'MANUAL_STATUS_UPDATE',
  })

  if (transition.error) {
    redirectWithMessage(returnTo, getCaseActionHint(transition.error.message))
  }

  const previousStatus = existingCase?.status ?? 'UNKNOWN'

  await logCaseEvent(caseId, user.id, `STATUS_CHANGE`, `Status changed from ${previousStatus} to ${status}.`, {
    previous_status: previousStatus,
    new_status: status,
  })

  if (isAttorneyRole(role)) {
    await updateCaseRecordSafe(supabase, caseId, {
      attorney_update_date: getTodayDateValue(),
    })
  }

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, `Status updated to ${status}.`)
}

export async function updateCaseNextCourtDate(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const nextCourtDate = parseDateToYmd(String(formData.get('next_court_date') ?? ''))

  if (!caseId || !nextCourtDate) {
    redirectWithMessage(returnTo, 'Valid next court date is required.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can update next court date.')
  }

  const courtDatePatch: Record<string, unknown> = {
    court_date: nextCourtDate,
    updated_at: new Date().toISOString(),
  }
  if (isAttorneyRole(role)) {
    courtDatePatch.attorney_update_date = getTodayDateValue()
  }

  const updateError = await updateCaseRecordSafe(supabase, caseId, courtDatePatch)

  if (updateError) {
    redirectWithMessage(returnTo, getCaseActionHint(updateError))
  }

  await logCaseEvent(caseId, user.id, 'NEXT_COURT_DATE_SET', `Next court date set to ${nextCourtDate}.`, {
    next_court_date: nextCourtDate,
  })

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'case_court', itemId: caseId })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'case_court', itemId: caseId },
    action: 'UPSERT',
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, `Next court date set to ${nextCourtDate}.`)
}

export async function addCaseHearingShortcut(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const hearingDate = parseDateToYmd(String(formData.get('hearing_date') ?? ''))
  const hearingTime = String(formData.get('hearing_time') ?? '').trim() || '09:00'
  const title = String(formData.get('title') ?? '').trim()

  if (!caseId || !hearingDate) {
    redirectWithMessage(returnTo, 'Hearing date is required.')
  }

  const startAt = combineDateTimeToIso(hearingDate, hearingTime, '09:00')
  if (!startAt) {
    redirectWithMessage(returnTo, 'Valid hearing date and time are required.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can add hearings.')
  }

  const caseRes = await supabase
    .from('cases')
    .select('id, attorney_firm_id, assigned_attorney_user_id, court_name, court_address, state, county, citation_number')
    .eq('id', caseId)
    .maybeSingle<{
      id: string
      attorney_firm_id: string | null
      assigned_attorney_user_id: string | null
      court_name: string | null
      court_address: string | null
      state: string
      county: string | null
      citation_number: string | null
    }>()

  if (caseRes.error || !caseRes.data) {
    redirectWithMessage(returnTo, getCaseActionHint(caseRes.error?.message || 'Case not found.'))
  }

  const hearingMeta = getCalendarEventTypeMeta('HEARING')
  const startAtDate = new Date(startAt)
  const endAt = new Date(startAtDate.getTime() + hearingMeta.defaultDuration * 60000).toISOString()
  const eventTitle =
    title ||
    caseRes.data.court_name ||
    (caseRes.data.citation_number ? `Hearing - ${caseRes.data.citation_number}` : 'Case Hearing')

  const insert = await supabase
    .from('attorney_calendar_events')
    .insert({
      firm_id: caseRes.data.attorney_firm_id,
      owner_user_id: user.id,
      assigned_user_id: caseRes.data.assigned_attorney_user_id ?? user.id,
      case_id: caseId,
      title: eventTitle,
      event_type: 'HEARING',
      start_at: startAt,
      end_at: endAt,
      all_day: false,
      location: caseRes.data.court_address,
      visibility: 'SHARED',
      status: 'SCHEDULED',
      linked_court: caseRes.data.court_name,
      linked_state: caseRes.data.state,
      linked_county: caseRes.data.county,
      reminder_offsets: [...hearingMeta.defaultReminderOffsets],
      prep_before_minutes: 30,
      travel_before_minutes: 20,
      travel_after_minutes: 20,
      metadata: {
        source: 'CASE_SHORTCUT',
        shortcut: 'ADD_HEARING',
        citation_number: caseRes.data.citation_number,
      },
    })
    .select('id')
    .single<{ id: string }>()

  if (insert.error || !insert.data?.id) {
    redirectWithMessage(returnTo, getCaseActionHint(insert.error?.message || 'Could not create hearing event.'))
  }

  const casePatch: Record<string, unknown> = {
    court_date: hearingDate,
    court_time: hearingTime,
  }
  if (isAttorneyRole(role)) {
    casePatch.attorney_update_date = getTodayDateValue()
  }
  const updateError = await updateCaseRecordSafe(supabase, caseId, casePatch)
  if (updateError) {
    redirectWithMessage(returnTo, getCaseActionHint(updateError))
  }

  await logCaseEvent(caseId, user.id, 'CALENDAR_EVENT_CREATED', `Hearing added from case page: ${eventTitle}.`, {
    event_id: insert.data.id,
    event_type: 'HEARING',
    start_at: startAt,
    source: 'CASE_SHORTCUT',
  })

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'calendar', itemId: insert.data.id })
  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'case_court', itemId: caseId })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'calendar', itemId: insert.data.id },
    action: 'UPSERT',
  })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'case_court', itemId: caseId },
    action: 'UPSERT',
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, 'Hearing added to the calendar.')
}

export async function addCaseFollowUpShortcut(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const followUpDate = parseDateToYmd(String(formData.get('follow_up_date') ?? ''))
  const followUpTime = String(formData.get('follow_up_time') ?? '').trim() || '09:00'
  const title = String(formData.get('title') ?? '').trim()

  if (!caseId || !followUpDate) {
    redirectWithMessage(returnTo, 'Follow-up date is required.')
  }

  const dueAt = combineDateTimeToIso(followUpDate, followUpTime, '09:00')
  if (!dueAt) {
    redirectWithMessage(returnTo, 'Valid follow-up date and time are required.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can add follow-ups.')
  }

  const followUpMeta = getCalendarEventTypeMeta('FOLLOW_UP')
  const taskInsert = await supabase
    .from('case_tasks')
    .insert({
      case_id: caseId,
      task_type: 'ATTORNEY_REMINDER',
      requested_by_user_id: user.id,
      target_role: 'ATTORNEY',
      target_user_id: user.id,
      instructions: title || 'Follow up on case progress',
      status: 'OPEN',
      due_at: dueAt,
      metadata: {
        source: 'CASE_SHORTCUT',
        shortcut: 'ADD_FOLLOW_UP',
        event_type: 'FOLLOW_UP',
        start_at: dueAt,
        end_at: new Date(new Date(dueAt).getTime() + followUpMeta.defaultDuration * 60000).toISOString(),
        reminder_offsets: [...followUpMeta.defaultReminderOffsets],
      },
    })
    .select('id')
    .single<{ id: string }>()

  if (taskInsert.error || !taskInsert.data?.id) {
    redirectWithMessage(returnTo, getCaseActionHint(taskInsert.error?.message || 'Could not create follow-up reminder.'))
  }

  if (isAttorneyRole(role)) {
    await updateCaseRecordSafe(supabase, caseId, {
      attorney_update_date: getTodayDateValue(),
    })
  }

  await logCaseEvent(caseId, user.id, 'TASK_CREATED', `Follow-up added from case page: ${title || 'Follow up on case progress'}.`, {
    task_id: taskInsert.data.id,
    due_at: dueAt,
    source: 'CASE_SHORTCUT',
  })

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'task', itemId: taskInsert.data.id })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'task', itemId: taskInsert.data.id },
    action: 'UPSERT',
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/reminders')
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, 'Follow-up reminder added.')
}

export async function updateAttorneyCaseTracking(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const courtCaseNumber = String(formData.get('court_case_number') ?? '').trim()
  const attorneyUpdateDate = parseDateToYmd(String(formData.get('attorney_update_date') ?? ''))

  if (!caseId) {
    redirectWithMessage(returnTo, 'Case id is required.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can update court case tracking.')
  }

  const existing = await readCaseMetadataForWriter(supabase, caseId)
  if (existing.error) {
    redirectWithMessage(returnTo, getCaseActionHint(existing.error.message))
  }

  const rawMetadata = existing.data?.metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata) ? { ...rawMetadata } : {}
  const nowIso = new Date().toISOString()

  if (courtCaseNumber) metadata['court_case_number'] = courtCaseNumber
  else delete metadata['court_case_number']

  if (attorneyUpdateDate) metadata['attorney_update_date'] = attorneyUpdateDate
  else delete metadata['attorney_update_date']

  metadata['attorney_case_updated_at'] = nowIso

  const updateError = await updateCaseRecordSafe(supabase, caseId, {
    court_case_number: courtCaseNumber || null,
    attorney_update_date: attorneyUpdateDate,
    metadata,
    updated_at: nowIso,
  })

  if (updateError) {
    redirectWithMessage(returnTo, getCaseActionHint(updateError))
  }

  await logCaseEvent(caseId, user.id, 'ATTORNEY_CASE_TRACKING_UPDATED', 'Attorney case tracking updated.', {
    court_case_number: courtCaseNumber || null,
    attorney_update_date: attorneyUpdateDate,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, 'Attorney case tracking saved.')
}

export async function uploadCaseDocument(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const docType = String(formData.get('doc_type') ?? '').trim() || 'OTHER'
  const fileEntry = formData.get('document')
  const file = fileEntry instanceof File ? fileEntry : null
  const returnTo = getReturnTarget(formData, caseId)

  if (!caseId || !file || file.size === 0) {
    redirectWithMessage(returnTo, 'Please choose a file to upload.')
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    redirectWithMessage(returnTo, 'File must be 10MB or smaller.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const safeName = cleanFileName(file.name || 'document')
  const storagePath = `${caseId}/${Date.now()}-${safeName}`

  const uploadResult = await supabase.storage.from('case-documents').upload(storagePath, file, {
    contentType: file.type || 'application/octet-stream',
    cacheControl: '3600',
    upsert: false,
  })

  if (uploadResult.error) {
    redirectWithMessage(returnTo, getCaseActionHint(uploadResult.error.message))
  }

  let documentId = ''
  try {
    documentId = await insertDocumentSafe(supabase, {
      case_id: caseId,
      doc_type: docType,
      filename: file.name,
      storage_path: storagePath,
      uploaded_by: user.id,
      ocr_status: SYNC_OCR_ON_UPLOAD ? 'PROCESSING' : 'PENDING',
    })
  } catch (error) {
    await supabase.storage.from('case-documents').remove([storagePath])
    const message = error instanceof Error ? error.message : 'Failed to save document record.'
    redirectWithMessage(returnTo, getCaseActionHint(message))
  }

  await logCaseEvent(caseId, user.id, 'DOCUMENT_UPLOAD', `Uploaded document ${file.name}.`, {
    file_name: file.name,
    doc_type: docType,
    storage_path: storagePath,
  })

  if (SYNC_OCR_ON_UPLOAD) {
    const ocrResult = await runDocumentOcrInternal(supabase, {
      caseId,
      documentId,
      storagePath,
      actorId: user.id,
    })

    revalidatePath(`/cases/${caseId}`)
    revalidatePath('/dashboard')
    revalidatePath('/attorney/dashboard')
    revalidatePath(returnTo.split('?')[0])

    if (!ocrResult.ok) {
      redirectWithMessage(returnTo, `Document uploaded. OCR: ${ocrResult.message}`)
    }

    redirectWithMessage(returnTo, 'Document uploaded and OCR completed.')
  }

  const queued = await enqueueDocumentOcrJob(supabase, {
    caseId,
    documentId,
    storagePath,
    requestedBy: user.id,
    source: 'CASE_UPLOAD',
  })

  if (!queued.ok) {
    if (shouldUseSyncOcrFallback(queued.message)) {
      const fallback = await runDocumentOcrInternal(supabase, {
        caseId,
        documentId,
        storagePath,
        actorId: user.id,
      })

      revalidatePath(`/cases/${caseId}`)
      revalidatePath('/dashboard')
      revalidatePath('/attorney/dashboard')
      revalidatePath(returnTo.split('?')[0])

      if (!fallback.ok) {
        redirectWithMessage(returnTo, `Document uploaded, but OCR fallback failed: ${fallback.message}`)
      }

      redirectWithMessage(returnTo, 'Document uploaded and OCR completed.')
    }

    await updateDocumentSafe(supabase, documentId, {
      ocr_status: 'FAILED',
      ocr_payload: { error: queued.message, source: 'OCR_JOB_QUEUE' },
    })
    redirectWithMessage(returnTo, `Document uploaded, but OCR queue failed: ${queued.message}`)
  }

  await logCaseEvent(caseId, user.id, 'OCR_QUEUED', 'OCR job queued for uploaded document.', {
    document_id: documentId,
    storage_path: storagePath,
    job_id: queued.jobId,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, 'Document uploaded. OCR queued.')
}

export async function toggleAttorneyWorkflowStep(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const stepKey = String(formData.get('step_key') ?? '').trim()
  const doneRaw = String(formData.get('done') ?? '').trim().toLowerCase()
  const done = doneRaw === '1' || doneRaw === 'true' || doneRaw === 'yes' || doneRaw === 'on'
  const returnTo = getReturnTarget(formData, caseId)

  if (!caseId || !isValidAttorneyWorkflowStep(stepKey)) {
    redirectWithMessage(returnTo, 'Invalid workflow step.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can update workflow steps.')
  }

  const existing = await readCaseMetadataForWriter(supabase, caseId)

  if (existing.error) {
    redirectWithMessage(returnTo, getCaseActionHint(existing.error.message))
  }

  const rawMetadata = existing.data?.metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata) ? rawMetadata : {}

  const currentStepsRaw = metadata['attorney_workflow_steps']
  const currentStepsSet = new Set(
    Array.isArray(currentStepsRaw)
      ? currentStepsRaw.map((value) => String(value).trim()).filter(Boolean)
      : []
  )

  if (done) {
    currentStepsSet.add(stepKey)
  } else {
    currentStepsSet.delete(stepKey)
  }

  const nowIso = new Date().toISOString()
  const nextMetadata: Record<string, unknown> = {
    ...metadata,
    attorney_workflow_steps: [...currentStepsSet],
    attorney_workflow_updated_at: nowIso,
  }

  const update = await supabase
    .from('cases')
    .update({
      metadata: nextMetadata,
      updated_at: nowIso,
    })
    .eq('id', caseId)

  if (update.error && /column .*metadata.* does not exist/i.test(update.error.message)) {
    const taskFallback = await supabase.from('case_tasks').insert({
      case_id: caseId,
      task_type: 'ATTORNEY_WORKFLOW_STEP',
      requested_by_user_id: user.id,
      target_role: 'ATTORNEY',
      status: done ? 'DONE' : 'OPEN',
      instructions: `${done ? 'Completed' : 'Reopened'} step: ${stepKey}`,
      due_at: null,
    })

    if (taskFallback.error) {
      redirectWithMessage(returnTo, getCaseActionHint(taskFallback.error.message))
    }

    await logCaseEvent(
      caseId,
      user.id,
      done ? 'WORKFLOW_STEP_COMPLETED' : 'WORKFLOW_STEP_REOPENED',
      `${done ? 'Completed' : 'Reopened'} workflow step: ${stepKey}.`,
      { step: stepKey, persisted_as: 'case_tasks_fallback' }
    )

    revalidatePath(`/cases/${caseId}`)
    revalidatePath('/dashboard')
    revalidatePath('/attorney/dashboard')
    revalidatePath(returnTo.split('?')[0])
    redirectWithMessage(returnTo, `Workflow step ${done ? 'completed' : 'reopened'}: ${stepKey}.`)
  }

  if (update.error) {
    redirectWithMessage(returnTo, getCaseActionHint(update.error.message))
  }

  await logCaseEvent(
    caseId,
    user.id,
    done ? 'WORKFLOW_STEP_COMPLETED' : 'WORKFLOW_STEP_REOPENED',
    `${done ? 'Completed' : 'Reopened'} workflow step: ${stepKey}.`,
    { step: stepKey, persisted_as: 'cases.metadata.attorney_workflow_steps' }
  )

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, `Workflow step ${done ? 'completed' : 'reopened'}: ${stepKey}.`)
}

export async function setAttorneyPrimaryStep(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const stepKey = String(formData.get('primary_step') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)

  if (!caseId || !isValidAttorneyWorkflowStep(stepKey)) {
    redirectWithMessage(returnTo, 'Invalid attorney step value.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can update attorney workflow.')
  }

  const existing = await readCaseMetadataForWriter(supabase, caseId)

  if (existing.error) {
    redirectWithMessage(returnTo, getCaseActionHint(existing.error.message))
  }

  const rawMetadata = existing.data?.metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata) ? rawMetadata : {}

  const currentStepsRaw = metadata['attorney_workflow_steps']
  const currentStepsSet = new Set(
    Array.isArray(currentStepsRaw)
      ? currentStepsRaw.map((value) => String(value).trim()).filter(Boolean)
      : []
  )
  currentStepsSet.add(stepKey)

  const nowIso = new Date().toISOString()
  const nextMetadata: Record<string, unknown> = {
    ...metadata,
    attorney_primary_step: stepKey,
    attorney_workflow_steps: [...currentStepsSet],
    attorney_workflow_updated_at: nowIso,
  }

  const updateError = await updateCaseRecordSafe(supabase, caseId, {
    metadata: nextMetadata,
    updated_at: nowIso,
    attorney_update_date: getTodayDateValue(),
  })

  if (updateError) {
    redirectWithMessage(returnTo, getCaseActionHint(updateError))
  }

  await logCaseEvent(caseId, user.id, 'ATTORNEY_PRIMARY_STEP_SET', `Primary attorney step set: ${stepKey}.`, {
    step: stepKey,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, `Attorney step set to ${stepKey}.`)
}

export async function saveAttorneyCaseSection(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const section = String(formData.get('section') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)

  if (!caseId || !isAttorneySection(section)) {
    redirectWithMessage(returnTo, 'Invalid attorney case section.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can update attorney case details.')
  }

  const existing = await readCaseMetadataForWriter(supabase, caseId)

  if (existing.error) {
    redirectWithMessage(returnTo, getCaseActionHint(existing.error.message))
  }

  const rawMetadata = existing.data?.metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata) ? rawMetadata : {}

  const attorneyCaseRaw = metadata['attorney_case']
  const attorneyCase: Record<string, unknown> =
    attorneyCaseRaw && typeof attorneyCaseRaw === 'object' && !Array.isArray(attorneyCaseRaw)
      ? { ...(attorneyCaseRaw as Record<string, unknown>) }
      : {}

  const currentSectionRaw = attorneyCase[section]
  const sectionPayload: Record<string, unknown> =
    currentSectionRaw && typeof currentSectionRaw === 'object' && !Array.isArray(currentSectionRaw)
      ? { ...(currentSectionRaw as Record<string, unknown>) }
      : {}

  const config = ATTORNEY_SECTION_CONFIG[section]

  for (const field of config.textFields) {
    const value = String(formData.get(field) ?? '').trim()
    if (value) {
      sectionPayload[field] = value
    } else {
      delete sectionPayload[field]
    }
  }

  for (const field of config.dateFields) {
    const parsed = parseDateToYmd(String(formData.get(field) ?? ''))
    if (parsed) {
      sectionPayload[field] = parsed
    } else {
      delete sectionPayload[field]
    }
  }

  for (const field of config.boolFields) {
    sectionPayload[field] = parseBool(formData, field)
  }

  for (const field of config.numberFields) {
    const parsed = parseOptionalNumber(String(formData.get(field) ?? ''))
    if (parsed === null) {
      delete sectionPayload[field]
    } else {
      sectionPayload[field] = parsed
    }
  }

  attorneyCase[section] = sectionPayload

  const nowIso = new Date().toISOString()
  const nextMetadata: Record<string, unknown> = {
    ...metadata,
    attorney_case: attorneyCase,
    attorney_case_updated_at: nowIso,
  }

  const update = await supabase
    .from('cases')
    .update({
      metadata: nextMetadata,
      updated_at: nowIso,
    })
    .eq('id', caseId)

  if (update.error) {
    redirectWithMessage(returnTo, getCaseActionHint(update.error.message))
  }

  await logCaseEvent(caseId, user.id, 'ATTORNEY_CASE_SECTION_UPDATED', `Updated attorney ${section} section.`, {
    section,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, `Attorney ${section} section saved.`)
}

export async function runDocumentOcrNow(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const documentId = String(formData.get('document_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)

  if (!caseId || !documentId) {
    redirectWithMessage(returnTo, 'Missing case or document id.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const { data: doc, error } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', documentId)
    .eq('case_id', caseId)
    .single<{ storage_path: string | null }>()

  if (error || !doc?.storage_path) {
    redirectWithMessage(returnTo, error?.message || 'Document path not found.')
  }

  if (SYNC_OCR_ON_UPLOAD) {
    const result = await runDocumentOcrInternal(supabase, {
      caseId,
      documentId,
      storagePath: doc.storage_path,
      actorId: user.id,
    })

    revalidatePath(`/cases/${caseId}`)
    revalidatePath('/dashboard')
    revalidatePath('/attorney/dashboard')
    revalidatePath(returnTo.split('?')[0])

    if (!result.ok) {
      redirectWithMessage(returnTo, `OCR failed: ${result.message}`)
    }

    redirectWithMessage(returnTo, 'OCR re-run completed.')
  }

  const queued = await enqueueDocumentOcrJob(supabase, {
    caseId,
    documentId,
    storagePath: doc.storage_path,
    requestedBy: user.id,
    source: 'OCR_RERUN',
  })

  if (!queued.ok) {
    if (shouldUseSyncOcrFallback(queued.message)) {
      const fallback = await runDocumentOcrInternal(supabase, {
        caseId,
        documentId,
        storagePath: doc.storage_path,
        actorId: user.id,
      })

      revalidatePath(`/cases/${caseId}`)
      revalidatePath('/dashboard')
      revalidatePath('/attorney/dashboard')
      revalidatePath(returnTo.split('?')[0])

      if (!fallback.ok) {
        redirectWithMessage(returnTo, `OCR fallback failed: ${fallback.message}`)
      }

      redirectWithMessage(returnTo, 'OCR re-run completed.')
    }

    redirectWithMessage(returnTo, `OCR queue failed: ${queued.message}`)
  }

  await logCaseEvent(caseId, user.id, 'OCR_QUEUED', 'OCR re-run queued.', {
    document_id: documentId,
    job_id: queued.jobId,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, 'OCR re-run queued.')
}

export async function requestAttorneyQuote(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const instructions = String(formData.get('instructions') ?? '').trim()

  if (!caseId) {
    redirect('/dashboard?message=Missing%20case%20id.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isStaffRole(role) && role !== 'AGENCY' && role !== 'FLEET') {
    redirectWithMessage(returnTo, 'Only agency, fleet, or admin roles can request quotes.')
  }

  const taskInsert = await supabase.from('case_tasks').insert({
    case_id: caseId,
    task_type: 'ATTORNEY_QUOTE_REQUEST',
    requested_by_user_id: user.id,
    target_role: 'ATTORNEY',
    instructions: instructions || 'Please review and provide a quote for this case.',
    status: 'OPEN',
    due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  })

  if (taskInsert.error) {
    redirectWithMessage(returnTo, getCaseActionHint(taskInsert.error.message))
  }

  const transition = await transitionCaseStatus(supabase, {
    caseId,
    toStatus: 'ATTORNEY_MATCHING',
    reason: 'REQUEST_ATTORNEY_QUOTE',
  })

  if (transition.error) {
    redirectWithMessage(returnTo, getCaseActionHint(transition.error.message))
  }

  await logCaseEvent(caseId, user.id, 'QUOTE_REQUESTED', 'Attorney quote requested.', {
    instructions: instructions || null,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, 'Attorney quote request created.')
}

export async function requestAttorneyUpdate(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const instructions = String(formData.get('instructions') ?? '').trim()

  if (!caseId) {
    redirect('/dashboard?message=Missing%20case%20id.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  const canRequest = isStaffRole(role) || role === 'AGENCY' || role === 'FLEET' || role === 'DRIVER'
  if (!canRequest) {
    redirectWithMessage(returnTo, 'You do not have permission to request updates.')
  }

  const taskInsert = await supabase.from('case_tasks').insert({
    case_id: caseId,
    task_type: 'ATTORNEY_UPDATE_REQUEST',
    requested_by_user_id: user.id,
    target_role: 'ATTORNEY',
    instructions: instructions || 'Please provide a case progress update.',
    status: 'OPEN',
    due_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  })

  if (taskInsert.error) {
    redirectWithMessage(returnTo, getCaseActionHint(taskInsert.error.message))
  }

  await logCaseEvent(caseId, user.id, 'UPDATE_REQUESTED', 'Attorney update requested.', {
    instructions: instructions || null,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, 'Update request sent to attorney.')
}

export async function sendCaseMessage(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const recipientRole = String(formData.get('recipient_role') ?? '').trim().toUpperCase()
  const message = String(formData.get('message') ?? '').trim()

  if (!caseId || !message) {
    redirectWithMessage(returnTo, 'Message text is required.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const insert = await supabase.from('case_messages').insert({
    case_id: caseId,
    sender_user_id: user.id,
    recipient_role: recipientRole || null,
    body: message,
  })

  if (insert.error) {
    redirectWithMessage(returnTo, getCaseActionHint(insert.error.message))
  }

  await logCaseEvent(caseId, user.id, 'MESSAGE_SENT', 'Case message sent.', {
    to_role: recipientRole || null,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, 'Message sent.')
}

export async function updateDriverCaseFleetMonitoring(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const shareWithFleet = parseBool(formData, 'share_with_fleet')
  const requestedFleetId = String(formData.get('fleet_id') ?? '').trim()

  if (!caseId) {
    redirect('/dashboard?message=Missing%20case%20id.')
  }

  const { user, role, caseRow } = await requireDriverCaseMonitoringContext(caseId, returnTo)
  const admin = createServiceRoleClient()
  const nowIso = new Date().toISOString()

  if (!shareWithFleet) {
    const update = await admin
      .from('cases')
      .update({
        fleet_id: null,
        updated_at: nowIso,
      })
      .eq('id', caseId)

    if (update.error) {
      redirectWithMessage(returnTo, getCaseActionHint(update.error.message))
    }

    await logCaseEvent(caseId, user.id, 'CASE_FLEET_MONITORING_REMOVED', 'Fleet monitoring removed from case.', {
      previous_fleet_id: caseRow.fleet_id ?? null,
      previous_agency_id: caseRow.agency_id ?? null,
    })

    revalidateCaseWorkspacePaths(caseId, returnTo)
    redirectWithMessage(returnTo, 'Fleet monitoring removed from this case.')
  }

  const targetFleet = await resolveFleetMonitoringTarget({
    admin,
    userId: user.id,
    role,
    requestedFleetId,
    currentCaseFleetId: caseRow.fleet_id ?? null,
    returnTo,
  })

  const update = await admin
    .from('cases')
    .update({
      fleet_id: targetFleet.id,
      agency_id: targetFleet.agencyId,
      updated_at: nowIso,
    })
    .eq('id', caseId)

  if (update.error) {
    redirectWithMessage(returnTo, getCaseActionHint(update.error.message))
  }

  await logCaseEvent(
    caseId,
    user.id,
    caseRow.fleet_id === targetFleet.id ? 'CASE_FLEET_MONITORING_CONFIRMED' : 'CASE_FLEET_MONITORING_SHARED',
    caseRow.fleet_id === targetFleet.id
      ? `Fleet monitoring kept with ${targetFleet.companyName}.`
      : `Case shared with fleet ${targetFleet.companyName}.`,
    {
      fleet_id: targetFleet.id,
      agency_id: targetFleet.agencyId,
      previous_fleet_id: caseRow.fleet_id ?? null,
      previous_agency_id: caseRow.agency_id ?? null,
    }
  )

  revalidateCaseWorkspacePaths(caseId, returnTo)
  redirectWithMessage(returnTo, `Fleet monitoring saved for ${targetFleet.companyName}.`)
}

export async function inviteFleetMonitorForCase(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const requestedFleetId = String(formData.get('fleet_id') ?? '').trim()

  if (!caseId) {
    redirect('/dashboard?message=Missing%20case%20id.')
  }

  if (!email || !email.includes('@')) {
    redirectWithMessage(returnTo, 'A valid fleet monitor email is required.')
  }

  const { supabase, user, role, caseRow } = await requireDriverCaseMonitoringContext(caseId, returnTo)
  const admin = createServiceRoleClient()
  const nowIso = new Date().toISOString()

  let targetAgencyId = caseRow.agency_id ?? null
  let targetFleetId = requestedFleetId || caseRow.fleet_id || ''
  let targetFleetName = targetFleetId

  if (targetFleetId) {
    const targetFleet = await resolveFleetMonitoringTarget({
      admin,
      userId: user.id,
      role,
      requestedFleetId: targetFleetId,
      currentCaseFleetId: caseRow.fleet_id ?? null,
      returnTo,
    })
    targetFleetId = targetFleet.id
    targetAgencyId = targetFleet.agencyId
    targetFleetName = targetFleet.companyName

    if (caseRow.fleet_id !== targetFleet.id || caseRow.agency_id !== targetAgencyId) {
      const update = await admin
        .from('cases')
        .update({
          fleet_id: targetFleet.id,
          agency_id: targetAgencyId,
          updated_at: nowIso,
        })
        .eq('id', caseId)

      if (update.error) {
        redirectWithMessage(returnTo, getCaseActionHint(update.error.message))
      }
    }
  } else if (!targetAgencyId) {
    redirectWithMessage(
      returnTo,
      'Link this case to a fleet first, or keep an agency on the case before inviting a fleet monitor.'
    )
  }

  const inviteInsert = await admin.from('platform_invites').insert({
    email,
    target_role: 'FLEET',
    agency_id: targetAgencyId,
    fleet_id: targetFleetId || null,
    invited_by: user.id,
  })

  if (inviteInsert.error) {
    const duplicateInvite =
      /duplicate key value|already exists|idx_platform_invites_active_email/i.test(inviteInsert.error.message)
    if (duplicateInvite) {
      redirectWithMessage(
        returnTo,
        `A pending fleet invite already exists for ${email}. Remove the older invite before sending another.`
      )
    }
    redirectWithMessage(returnTo, getCaseActionHint(inviteInsert.error.message))
  }

  const emailDispatch = await sendAuthInviteEmail(supabase, email, 'FLEET')

  await logCaseEvent(caseId, user.id, 'CASE_FLEET_MONITOR_INVITED', 'Fleet monitor invited from case view.', {
    email,
    fleet_id: targetFleetId || null,
    agency_id: targetAgencyId,
    email_notice: emailDispatch.notice,
  })

  revalidateCaseWorkspacePaths(caseId, returnTo)
  redirectWithMessage(
    returnTo,
    `Fleet monitor invite created for ${email}.${targetFleetName ? ` Scope: ${targetFleetName}.` : ''} ${emailDispatch.notice}`
  )
}

export async function inviteCaseParticipant(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const targetRole = String(formData.get('target_role') ?? '').trim().toUpperCase()
  const email = String(formData.get('email') ?? '').trim().toLowerCase()

  if (!caseId || !email || !email.includes('@')) {
    redirectWithMessage(returnTo, 'Valid invite email is required.')
  }

  if (targetRole !== 'DRIVER' && targetRole !== 'AGENCY') {
    redirectWithMessage(returnTo, 'Invite target must be DRIVER or AGENCY.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can send case invites.')
  }

  const caseRowRes = await supabase
    .from('cases')
    .select('id, metadata, agency_id, fleet_id, attorney_firm_id')
    .eq('id', caseId)
    .maybeSingle<{
      id: string
      metadata: Record<string, unknown> | null
      agency_id: string | null
      fleet_id: string | null
      attorney_firm_id: string | null
    }>()

  if (caseRowRes.error || !caseRowRes.data) {
    redirectWithMessage(returnTo, getCaseActionHint(caseRowRes.error?.message || 'Case not found.'))
  }

  if (!isStaffRole(role) && !isAttorneyExternalCase(caseRowRes.data.metadata)) {
    redirectWithMessage(
      returnTo,
      'Invites from this page are available for attorney-originated external-source cases.'
    )
  }

  const inviteInsert = await supabase.from('platform_invites').insert({
    email,
    target_role: targetRole,
    agency_id: targetRole === 'AGENCY' || targetRole === 'DRIVER' ? caseRowRes.data.agency_id : null,
    fleet_id: targetRole === 'DRIVER' ? caseRowRes.data.fleet_id : null,
    firm_id: caseRowRes.data.attorney_firm_id,
    invited_by: user.id,
  })

  if (inviteInsert.error) {
    const duplicateInvite =
      /duplicate key value|already exists|idx_platform_invites_active_email/i.test(inviteInsert.error.message)
    if (duplicateInvite) {
      redirectWithMessage(
        returnTo,
        `Pending invite already exists for ${email} (${targetRole}). Remove pending activation first, then resend.`
      )
    }
    redirectWithMessage(returnTo, getCaseActionHint(inviteInsert.error.message))
  }

  const emailDispatch = await sendAuthInviteEmail(supabase, email, targetRole as PlatformRole)

  await logCaseEvent(caseId, user.id, 'CASE_PARTICIPANT_INVITE_SENT', `Case invite sent to ${targetRole}.`, {
    target_role: targetRole,
    email,
    dispatch_notice: emailDispatch.notice,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath('/admin/cases')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, `Invite created for ${email}. ${emailDispatch.notice}`)
}

export async function requestSignedDocument(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTarget(formData, caseId)
  const instructions = String(formData.get('instructions') ?? '').trim()

  if (!caseId) {
    redirect('/dashboard?message=Missing%20case%20id.')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const role = await getCurrentUserRole(supabase, user.id)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirectWithMessage(returnTo, 'Only attorney or admin roles can request signed documents.')
  }

  const taskInsert = await supabase.from('case_tasks').insert({
    case_id: caseId,
    task_type: 'SIGNED_DOCUMENT_REQUEST',
    requested_by_user_id: user.id,
    target_role: 'AGENCY',
    instructions: instructions || 'Please review and sign the requested document package.',
    status: 'OPEN',
    due_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
  })

  if (taskInsert.error) {
    redirectWithMessage(returnTo, getCaseActionHint(taskInsert.error.message))
  }

  await logCaseEvent(caseId, user.id, 'SIGNED_DOC_REQUESTED', 'Signed document request created.', {
    instructions: instructions || null,
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/dashboard')
  revalidatePath('/attorney/dashboard')
  revalidatePath(returnTo.split('?')[0])
  redirectWithMessage(returnTo, 'Signed document request created.')
}
