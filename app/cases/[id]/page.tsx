import Link from 'next/link'
import { redirect } from 'next/navigation'
import { adminCreateManualAttorneyMatch, adminRunAttorneyMatching } from '@/app/admin/actions'
import {
  getCaseAttorneyUpdateDate,
  getCaseCourtCaseNumber,
  getCaseDisplayDriverName,
  getCaseSubmittedByRole,
  getCaseSubmittedByUserId,
  getCaseSubmitterEmail,
  getCaseSubmitterName,
  getCaseSubmitterPhone,
  getCaseViolationDate,
} from '@/app/lib/cases/display'
import { syncAttorneyMatchingCoverageForJurisdiction } from '@/app/lib/matching/attorneyCoverageSync'
import { claimRoleInvitesSafe } from '@/app/lib/server/claim-invites'
import { getAccessibleFleetRows, getFleetRowsByIds, type AccessibleFleetRow } from '@/app/lib/server/fleet-access'
import { getOptionalServiceRoleClient } from '@/app/lib/server/optional-service-role'
import { getEnabledFeaturesForRole, hasPlatformFeature, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { createClient } from '@/app/lib/supabase/server'
import { isAttorneyRole, isStaffRole, normalizePlatformRole, type PlatformRole } from '@/app/lib/roles'
import {
  addCaseFollowUpShortcut,
  addCaseHearingShortcut,
  inviteCaseParticipant,
  inviteFleetMonitorForCase,
  requestAttorneyQuote,
  requestAttorneyUpdate,
  saveAttorneyCaseSection,
  requestSignedDocument,
  runDocumentOcrNow,
  sendCaseMessage,
  setAttorneyPrimaryStep,
  toggleAttorneyWorkflowStep,
  updateDriverCaseFleetMonitoring,
  updateAttorneyCaseTracking,
  updateCaseNextCourtDate,
  updateCaseStatus,
  uploadCaseDocument,
} from './actions'
import { requestCasePayment } from '@/app/dashboard/actions'
import { ATTORNEY_CASE_STATUSES, ATTORNEY_WORKFLOW_STEPS, CASE_STATUSES } from '@/app/lib/case-status'

type CaseRow = {
  id: string
  state: string
  county: string | null
  citation_number: string | null
  violation_code: string | null
  violation_date?: string | null
  court_name?: string | null
  court_date: string | null
  court_time?: string | null
  court_case_number?: string | null
  attorney_update_date?: string | null
  status: string
  notes?: string | null
  metadata?: Record<string, unknown> | null
  owner_id: string | null
  driver_id?: string | null
  agency_id?: string | null
  fleet_id?: string | null
  submitter_email?: string | null
  submitter_user_id?: string | null
  attorney_firm_id?: string | null
  pricing_available?: boolean | null
  attorney_fee_cents?: number | null
  platform_fee_cents?: number | null
  total_price_cents?: number | null
  show_paid_pricing_to_fleet_driver?: boolean | null
  keep_agency_as_primary_contact?: boolean | null
  primary_contact_type?: string | null
  payment_flow_status?: string | null
  quote_requested_at?: string | null
  quote_received_at?: string | null
  payment_request_sent_at?: string | null
  created_at: string
  updated_at: string
}

type AttorneyFirmOption = {
  id: string
  company_name: string
}

type CaseQuoteRow = {
  id: string
  law_firm_org_id: string
  attorney_fee_cents: number
  platform_fee_cents: number
  total_cents: number
  status: string
  quote_source?: string | null
  created_at: string
}

type OutreachStatusRow = {
  status: string
  outreach_type?: string | null
  email?: string | null
  quoted_amount_cents?: number | null
  created_at?: string | null
  responded_at?: string | null
}

type PricingRow = {
  law_firm_org_id: string
  cdl_fee_cents: number
  non_cdl_fee_cents: number
}

type Document = {
  id: string
  doc_type: string
  filename: string | null
  storage_path: string | null
  created_at: string
  ocr_status?: string | null
  ocr_confidence?: number | null
  ocr_extracted?: Record<string, unknown> | null
  ocr_payload?: Record<string, unknown> | null
}

type CaseEvent = {
  id: string
  event_type: string
  event_summary: string
  metadata: Record<string, unknown> | null
  actor_id: string | null
  created_at: string
}

type CaseTask = {
  id: string
  task_type: string
  target_role: string | null
  status: string
  due_at: string | null
  created_at: string
  instructions: string | null
}

type CaseMessage = {
  id: string
  sender_user_id: string | null
  recipient_role: string | null
  body: string
  created_at: string
}

type DocumentView = Document & {
  signedUrl: string | null
}

type ProfileLookupRow = {
  id?: string | null
  user_id?: string | null
  full_name?: string | null
  email?: string | null
  system_role?: string | null
}

type ViewerRoleRow = {
  system_role: string | null
}

type PaymentRequestRow = {
  id: string
  quote_id: string | null
  amount_cents: number
  status: string
  source_type?: string | null
  provider?: string | null
  request_email?: string | null
  due_at?: string | null
  sent_at?: string | null
  paid_at?: string | null
  created_at: string
}

type AgencyDirectoryRow = {
  id: string
  company_name: string
}

type QueryClient = Awaited<ReturnType<typeof createClient>>

const CASE_SELECT_VARIANTS = [
  'id, state, county, citation_number, violation_code, violation_date, court_name, court_date, court_time, court_case_number, attorney_update_date, status, notes, metadata, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, created_at, updated_at',
  'id, state, county, citation_number, violation_code, violation_date, court_name, court_date, court_time, court_case_number, status, notes, metadata, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, created_at, updated_at',
  'id, state, county, citation_number, violation_code, court_date, court_time, status, notes, metadata, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, created_at, updated_at',
  'id, state, county, citation_number, violation_code, court_date, court_time, status, notes, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, created_at, updated_at',
  'id, state, county, citation_number, violation_code, court_date, court_time, status, metadata, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, created_at, updated_at',
  'id, state, county, citation_number, violation_code, court_date, court_time, status, owner_id, driver_id, agency_id, fleet_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, created_at, updated_at',
  'id, state, county, citation_number, violation_code, violation_date, court_name, court_date, court_time, court_case_number, attorney_update_date, status, notes, metadata, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, created_at, updated_at',
  'id, state, county, citation_number, violation_code, violation_date, court_name, court_date, court_time, court_case_number, status, notes, metadata, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, created_at, updated_at',
  'id, state, county, citation_number, violation_code, court_date, court_time, status, notes, metadata, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, created_at, updated_at',
  'id, state, county, citation_number, violation_code, court_date, court_time, status, notes, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, created_at, updated_at',
  'id, state, county, citation_number, violation_code, court_date, court_time, status, metadata, owner_id, driver_id, agency_id, fleet_id, submitter_email, submitter_user_id, attorney_firm_id, created_at, updated_at',
  'id, state, county, citation_number, violation_code, court_date, court_time, status, owner_id, driver_id, agency_id, fleet_id, created_at, updated_at',
]

const CASE_LAST_SEEN_KEY = 'case_last_seen_by_user'

function isMissingColumnError(message: string) {
  return /column .* does not exist/i.test(message) || /could not find the '.*' column/i.test(message)
}

async function loadCaseRow(
  supabase: QueryClient,
  caseId: string
) {
  let lastError = ''

  for (const selection of CASE_SELECT_VARIANTS) {
    const { data, error } = await supabase.from('cases').select(selection).eq('id', caseId).single<CaseRow>()
    if (!error && data) return { data, error: null as string | null }

    if (!error) continue
    lastError = error.message
    if (!isMissingColumnError(error.message)) break
  }

  return { data: null as CaseRow | null, error: lastError || 'Could not load case.' }
}

async function resolveViewerRole(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const byId = await supabase
    .from('profiles')
    .select('system_role')
    .eq('id', userId)
    .maybeSingle<ViewerRoleRow>()

  if (!byId.error && byId.data) return normalizePlatformRole(byId.data.system_role)

  const byUserId = await supabase
    .from('profiles')
    .select('system_role')
    .eq('user_id', userId)
    .maybeSingle<ViewerRoleRow>()

  return normalizePlatformRole(byUserId.data?.system_role)
}

function deriveNotes(caseRow: CaseRow) {
  const direct = String(caseRow.notes ?? '').trim()
  if (direct) return direct

  const metadata = caseRow.metadata ?? {}
  const candidates = [
    metadata['notes'],
    metadata['intake_notes'],
    metadata['note'],
  ]

  for (const value of candidates) {
    const text = String(value ?? '').trim()
    if (text) return text
  }

  return '-'
}

function deriveOcrError(doc: Document) {
  if (!doc.ocr_payload) return ''
  const raw = doc.ocr_payload['error']
  return String(raw ?? '').trim()
}

function getAttorneyWorkflowCompletedSteps(caseRow: CaseRow) {
  const metadata = caseRow.metadata ?? {}
  const raw = metadata['attorney_workflow_steps']
  if (!Array.isArray(raw)) return new Set<string>()
  return new Set(raw.map((value) => String(value).trim()).filter(Boolean))
}

function getAttorneyPrimaryStep(caseRow: CaseRow) {
  const metadata = caseRow.metadata ?? {}
  const raw = String(metadata['attorney_primary_step'] ?? '').trim()
  return ATTORNEY_WORKFLOW_STEPS.includes(raw as (typeof ATTORNEY_WORKFLOW_STEPS)[number]) ? raw : ''
}

function getAttorneySection(caseRow: CaseRow, section: 'management' | 'jury' | 'close' | 'defendant') {
  const metadata = caseRow.metadata ?? {}
  const attorneyCaseRaw = metadata['attorney_case']
  if (!attorneyCaseRaw || typeof attorneyCaseRaw !== 'object' || Array.isArray(attorneyCaseRaw)) return {}
  const sectionRaw = (attorneyCaseRaw as Record<string, unknown>)[section]
  if (!sectionRaw || typeof sectionRaw !== 'object' || Array.isArray(sectionRaw)) return {}
  return sectionRaw as Record<string, unknown>
}

function readSectionText(section: Record<string, unknown>, field: string) {
  return String(section[field] ?? '')
}

function readSectionBool(section: Record<string, unknown>, field: string) {
  return section[field] === true
}

function getMetadataRecord(caseRow: CaseRow) {
  const raw = caseRow.metadata
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

function getCaseSourceLabel(caseRow: CaseRow) {
  const metadata = getMetadataRecord(caseRow)
  const sourceRaw = String(
    metadata['case_source'] ?? metadata['source'] ?? metadata['intake_source'] ?? ''
  )
    .trim()
    .toUpperCase()
  const submittedByRole = String(metadata['submitted_by_role'] ?? '').trim().toUpperCase()
  const submittedVia = String(metadata['submitted_via'] ?? '').trim().toUpperCase()

  if (sourceRaw.includes('ATTORNEY') || submittedByRole === 'ATTORNEY' || submittedVia.includes('ATTORNEY')) {
    return { key: 'ATTORNEY_EXTERNAL', label: 'Attorney Uploaded (External Source)' }
  }

  if (!sourceRaw) {
    return { key: 'CDL_PROTECT', label: 'CDL Protect Intake' }
  }

  return {
    key: sourceRaw,
    label: sourceRaw
      .split('_')
      .map((chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase())
      .join(' '),
  }
}

async function markCaseSeen(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  caseRow: CaseRow
) {
  const metadata = getMetadataRecord(caseRow)
  const seenRaw = metadata[CASE_LAST_SEEN_KEY]
  const seenMap =
    seenRaw && typeof seenRaw === 'object' && !Array.isArray(seenRaw)
      ? { ...(seenRaw as Record<string, unknown>) }
      : {}
  const nowIso = new Date().toISOString()
  const existingSeen = String(seenMap[userId] ?? '').trim()
  const existingSeenMs = existingSeen ? Date.parse(existingSeen) : NaN

  if (!Number.isNaN(existingSeenMs) && Date.now() - existingSeenMs < 30 * 1000) {
    return
  }

  const nextMetadata: Record<string, unknown> = {
    ...metadata,
    [CASE_LAST_SEEN_KEY]: {
      ...seenMap,
      [userId]: nowIso,
    },
  }

  const update = await supabase.from('cases').update({ metadata: nextMetadata }).eq('id', caseRow.id)
  if (!update.error) return
}

function recipientRoleLabel(recipientRole: string | null) {
  if (!recipientRole) return 'All Participants'
  return `${recipientRole.toUpperCase()}`
}

function formatUsd(cents: number | null | undefined) {
  const value = Number(cents ?? 0)
  if (!Number.isFinite(value) || value <= 0) return '-'
  return `$${(value / 100).toFixed(2)}`
}

function formatShortDateLabel(value: string | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'Not scheduled'
  const parsed = new Date(raw)
  if (Number.isNaN(+parsed)) return raw
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatDateTime(value: string | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!raw) return '-'
  const parsed = new Date(raw)
  if (Number.isNaN(+parsed)) return raw
  return parsed.toLocaleString()
}

function formatFlowLabel(value: string | null | undefined) {
  const raw = String(value ?? '').trim().toUpperCase()
  if (!raw) return 'Not started'
  return raw
    .split('_')
    .map((chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase())
    .join(' ')
}

function formatCommaList(values: string[]) {
  if (!values.length) return '-'
  return values.join(', ')
}

function canViewerSeePricing(params: {
  role: PlatformRole
  userId: string
  caseRow: CaseRow
}) {
  if (isStaffRole(params.role) || isAttorneyRole(params.role) || params.role === 'AGENCY') {
    return true
  }

  if (params.userId && (params.userId === params.caseRow.submitter_user_id || params.userId === params.caseRow.owner_id)) {
    return true
  }

  if (params.role === 'FLEET' || params.role === 'DRIVER') {
    return params.caseRow.show_paid_pricing_to_fleet_driver === true
  }

  return true
}

function getPrimaryContactLabel(caseRow: CaseRow) {
  const primary = String(caseRow.primary_contact_type ?? '').trim().toUpperCase()
  if (primary === 'AGENCY' || caseRow.keep_agency_as_primary_contact) {
    return 'Agency'
  }
  return 'Submitter'
}

function getNextRequiredActionLabel({
  caseRow,
  openTaskCount,
  unreadMessageCount,
  currentQuote,
}: {
  caseRow: CaseRow
  openTaskCount: number
  unreadMessageCount: number
  currentQuote: CaseQuoteRow | null
}) {
  if (openTaskCount > 0) return `${openTaskCount} open tasks need attention`
  if (String(caseRow.status).toUpperCase() === 'NEEDS_REVIEW') return 'Complete matter triage and conflict review'
  if (!currentQuote && !caseRow.attorney_firm_id) return 'Route to attorney coverage or request pricing'
  if (unreadMessageCount > 0) return `Review ${unreadMessageCount} unread communications`
  if (caseRow.court_date) return 'Prepare for the next court appearance'
  return 'Matter is stable with no immediate blockers'
}

async function loadSenderLookup(readClient: QueryClient, senderIds: string[]) {
  const lookup = new Map<string, ProfileLookupRow>()
  if (!senderIds.length) return lookup

  const upsertRow = (row: ProfileLookupRow) => {
    const id = String(row.id ?? '').trim()
    const userId = String(row.user_id ?? '').trim()
    if (id) lookup.set(id, row)
    if (userId) lookup.set(userId, row)
  }

  const byIdRes = await readClient
    .from('profiles')
    .select('id, user_id, full_name, email, system_role')
    .in('id', senderIds)

  if (!byIdRes.error) {
    for (const row of (byIdRes.data ?? []) as ProfileLookupRow[]) upsertRow(row)
  } else if (isMissingColumnError(byIdRes.error.message)) {
    const byIdFallback = await readClient
      .from('profiles')
      .select('id, full_name, email, system_role')
      .in('id', senderIds)
    if (!byIdFallback.error) {
      for (const row of (byIdFallback.data ?? []) as ProfileLookupRow[]) upsertRow(row)
    }
  }

  const unresolved = senderIds.filter((id) => !lookup.has(id))
  if (!unresolved.length) return lookup

  const byUserRes = await readClient
    .from('profiles')
    .select('id, user_id, full_name, email, system_role')
    .in('user_id', unresolved)

  if (!byUserRes.error) {
    for (const row of (byUserRes.data ?? []) as ProfileLookupRow[]) upsertRow(row)
  }

  return lookup
}

function senderLabel(senderId: string | null, lookup: Map<string, ProfileLookupRow>, currentUserId: string) {
  if (!senderId) return 'Unknown Sender'
  if (senderId === currentUserId) return 'You'
  const row = lookup.get(senderId)
  if (!row) return senderId

  const fullName = String(row.full_name ?? '').trim()
  const email = String(row.email ?? '').trim()
  const role = String(row.system_role ?? '').trim().toUpperCase()
  const primary = fullName || email || senderId
  return role ? `${primary} (${role})` : primary
}

export default async function CaseDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ message?: string; return_to?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const supabase = await createClient()
  const readClient = getOptionalServiceRoleClient() ?? supabase
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in.')
  }

  await claimRoleInvitesSafe()

  const role = await resolveViewerRole(supabase, user.id)
  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
  const requestedReturnTo = String(query?.return_to ?? '').trim()
  const safeReturnTo = requestedReturnTo.startsWith('/') ? requestedReturnTo : ''
  const backHref = safeReturnTo || (isAttorneyRole(role) ? '/attorney/dashboard' : '/dashboard')
  const caseSelfHref = safeReturnTo ? `/cases/${id}?return_to=${encodeURIComponent(safeReturnTo)}` : `/cases/${id}`

  if (!hasPlatformFeature(enabledFeatures, 'cases_workspace')) {
    redirect(`${backHref}?message=${encodeURIComponent('Cases are disabled for this role.')}`)
  }

  const { data: caseRow, error: caseErr } = await loadCaseRow(supabase, id)

  if (caseErr || !caseRow) {
    return (
      <div style={{ marginTop: 20 }}>
        <Link href={backHref} style={{ textDecoration: 'none', color: '#0f4c81' }}>
          Back to Dashboard
        </Link>
        <h1>Case</h1>
        <p className="error">Error loading case: {caseErr || 'Case not found.'}</p>
      </div>
    )
  }

  const caseCalendarHref = `/attorney/calendar?view=case&case=${encodeURIComponent(caseRow.id)}&date=${encodeURIComponent(
    caseRow.court_date || new Date().toISOString().slice(0, 10)
  )}`
  const canUseAttorneyCalendar = hasPlatformFeature(enabledFeatures, 'attorney_calendar')
  const canRunAutoAttorneyMatching = hasPlatformFeature(enabledFeatures, 'attorney_matching_auto')
  const canRunManualAttorneyMatching = hasPlatformFeature(enabledFeatures, 'attorney_matching_manual')

  if (isStaffRole(role)) {
    try {
      await syncAttorneyMatchingCoverageForJurisdiction({
        state: caseRow.state,
        county: caseRow.county,
      })
    } catch (error) {
      console.error('Case page attorney coverage sync failed:', error)
    }
  }

  const { data: docs, error: docsErr } = await supabase
    .from('documents')
    .select('*')
    .eq('case_id', id)
    .order('created_at', { ascending: false })

  const { data: events, error: eventsErr } = await supabase
    .from('case_events')
    .select('id, event_type, event_summary, metadata, actor_id, created_at')
    .eq('case_id', id)
    .order('created_at', { ascending: false })

  const { data: tasks, error: tasksErr } = await supabase
    .from('case_tasks')
    .select('id, task_type, target_role, status, due_at, created_at, instructions')
    .eq('case_id', id)
    .order('created_at', { ascending: false })
    .limit(30)

  const { data: messages, error: messagesErr } = await supabase
    .from('case_messages')
    .select('id, sender_user_id, recipient_role, body, created_at')
    .eq('case_id', id)
    .order('created_at', { ascending: false })
    .limit(30)

  const [attorneyFirmsRes, quotesRes, outreachRes, pricingRes, paymentRequestsRes] = await Promise.all([
    isStaffRole(role)
      ? supabase.from('attorney_firms').select('id, company_name').eq('is_active', true).order('company_name', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('case_quotes')
      .select('id, law_firm_org_id, attorney_fee_cents, platform_fee_cents, total_cents, status, quote_source, created_at')
      .eq('case_id', id)
      .order('created_at', { ascending: false })
      .limit(8),
    isStaffRole(role)
      ? supabase
          .from('attorney_outreach')
          .select('status, outreach_type, email, quoted_amount_cents, created_at, responded_at')
          .eq('case_id', id)
          .order('created_at', { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),
    isStaffRole(role) && caseRow.state && caseRow.county
      ? supabase
          .from('attorney_pricing')
          .select('law_firm_org_id, cdl_fee_cents, non_cdl_fee_cents')
          .eq('state', String(caseRow.state).trim().toUpperCase())
          .eq('county', String(caseRow.county).trim().toUpperCase())
          .eq('is_active', true)
          .order('cdl_fee_cents', { ascending: true })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('payment_requests')
      .select('id, quote_id, amount_cents, status, source_type, provider, request_email, due_at, sent_at, paid_at, created_at')
      .eq('case_id', id)
      .order('created_at', { ascending: false })
      .limit(8),
  ])

  const caseSource = getCaseSourceLabel(caseRow)
  const isAttorneyExternalSource = caseSource.key === 'ATTORNEY_EXTERNAL'
  const messageRows = (messages ?? []) as CaseMessage[]
  const taskRows = (tasks ?? []) as CaseTask[]
  const eventRows = (events ?? []) as CaseEvent[]
  const attorneyFirms = (attorneyFirmsRes.data ?? []) as AttorneyFirmOption[]
  const quoteRows = (quotesRes.data ?? []) as CaseQuoteRow[]
  const outreachRows = (outreachRes.data ?? []) as OutreachStatusRow[]
  const pricingRows = (pricingRes.data ?? []) as PricingRow[]
  const paymentRequestRows = (paymentRequestsRes.data ?? []) as PaymentRequestRow[]
  const uploaderId = getCaseSubmittedByUserId(caseRow)
  const profileIds = [
    ...new Set(
      [...messageRows.map((row) => row.sender_user_id), uploaderId]
        .filter((value): value is string => Boolean(value))
    ),
  ]
  const profileLookup = await loadSenderLookup(supabase, profileIds)
  const uploaderProfile = uploaderId ? profileLookup.get(uploaderId) ?? null : null
  const uploaderAccountName =
    String(uploaderProfile?.full_name ?? '').trim() ||
    String(uploaderProfile?.email ?? '').trim() ||
    getCaseSubmitterEmail(caseRow) ||
    uploaderId ||
    '-'
  const uploaderAccountEmail =
    String(uploaderProfile?.email ?? '').trim() ||
    (getCaseSubmitterEmail(caseRow) !== uploaderAccountName ? getCaseSubmitterEmail(caseRow) : '') ||
    ''
  const uploaderRole =
    getCaseSubmittedByRole(caseRow) || String(uploaderProfile?.system_role ?? '').trim().toUpperCase() || '-'
  const submitterName = getCaseSubmitterName(caseRow)
  const submitterEmail = getCaseSubmitterEmail(caseRow)
  const submitterPhone = getCaseSubmitterPhone(caseRow)
  const firmNameById = new Map(attorneyFirms.map((firm) => [firm.id, firm.company_name]))
  const currentQuote =
    quoteRows.find((row) => ['OPEN', 'AWAITING_PAYMENT'].includes(String(row.status).toUpperCase())) ?? null
  const latestQuote = currentQuote ?? quoteRows[0] ?? null
  const latestPaymentRequest = paymentRequestRows[0] ?? null
  const openPaymentRequest =
    paymentRequestRows.find((row) => ['OPEN', 'PENDING_CHECKOUT'].includes(String(row.status).toUpperCase())) ?? null
  const pendingOutreachCount = outreachRows.filter((row) => String(row.status).toUpperCase() === 'PENDING').length
  const pricingByFirmId = new Map(pricingRows.map((row) => [row.law_firm_org_id, row]))
  const caseMetadata = getMetadataRecord(caseRow)
  const seenRaw = caseMetadata[CASE_LAST_SEEN_KEY]
  const seenMap =
    seenRaw && typeof seenRaw === 'object' && !Array.isArray(seenRaw)
      ? (seenRaw as Record<string, unknown>)
      : {}
  const viewerLastSeen = String(seenMap[user.id] ?? '').trim()
  const viewerLastSeenMs = viewerLastSeen ? Date.parse(viewerLastSeen) : Number.NaN
  const driverOwnsCase =
    role === 'DRIVER' &&
    (caseRow.owner_id === user.id || caseRow.submitter_user_id === user.id || caseRow.driver_id === user.id)

  await markCaseSeen(supabase, user.id, caseRow)

  const driverScopeFleetRows =
    role === 'DRIVER' ? await getAccessibleFleetRows(readClient, user.id, { includeArchived: true }) : []
  const driverScopeFleetIds = [
    ...new Set(
      [
        ...(caseRow.fleet_id ? [caseRow.fleet_id] : []),
        ...driverScopeFleetRows.map((fleet) => fleet.id),
      ].filter(Boolean)
    ),
  ]
  const driverMonitoringFleetRows: AccessibleFleetRow[] = driverScopeFleetIds.length
    ? await getFleetRowsByIds(readClient, driverScopeFleetIds, { includeArchived: true })
    : driverScopeFleetRows
  const driverMonitoringFleetOptions = driverMonitoringFleetRows.filter(
    (fleet) => fleet.id === caseRow.fleet_id || fleet.is_active !== false
  )
  const driverFleetSelectValue = caseRow.fleet_id ?? driverMonitoringFleetOptions[0]?.id ?? ''
  const currentCaseFleet = driverMonitoringFleetRows.find((fleet) => fleet.id === caseRow.fleet_id) ?? null
  const agencyIds = [
    ...new Set(
      [
        ...(caseRow.agency_id ? [caseRow.agency_id] : []),
        ...driverMonitoringFleetRows.map((fleet) => fleet.agency_id).filter(Boolean),
      ].filter(Boolean)
    ),
  ]
  const agenciesRes = agencyIds.length
    ? await readClient.from('agencies').select('id, company_name').in('id', agencyIds).limit(50)
    : { data: [] as AgencyDirectoryRow[], error: null }
  const agencyRows = (agenciesRes.data ?? []) as AgencyDirectoryRow[]
  const agencyNameById = new Map(agencyRows.map((agency) => [agency.id, agency.company_name]))
  const currentAgencyName =
    (caseRow.agency_id ? agencyNameById.get(caseRow.agency_id) : null) ??
    (currentCaseFleet?.agency_id ? agencyNameById.get(currentCaseFleet.agency_id) : null) ??
    null
  const driverLinkedFleetNames = driverScopeFleetRows.map((fleet) => fleet.company_name)
  const driverCanInviteFleetMonitor = driverOwnsCase && (Boolean(caseRow.agency_id) || driverMonitoringFleetOptions.length > 0)
  const showDriverFleetMonitoringControls =
    driverOwnsCase && (Boolean(caseRow.agency_id) || Boolean(caseRow.fleet_id) || driverMonitoringFleetOptions.length > 0)

  const docsWithLinks: DocumentView[] = await Promise.all(
    (docs ?? []).map(async (doc: Document) => {
      if (!doc.storage_path) {
        return { ...doc, signedUrl: null }
      }

      const signed = await supabase.storage.from('case-documents').createSignedUrl(doc.storage_path, 60 * 15)

      return {
        ...doc,
        signedUrl: signed.data?.signedUrl ?? null,
      }
    })
  )

  const statusOptions = isAttorneyRole(role) ? ATTORNEY_CASE_STATUSES : CASE_STATUSES
  const completedSteps = getAttorneyWorkflowCompletedSteps(caseRow)
  const completedStepCount = ATTORNEY_WORKFLOW_STEPS.filter((step) => completedSteps.has(step)).length
  const attorneyPrimaryStep = getAttorneyPrimaryStep(caseRow)
  const attorneyManagement = getAttorneySection(caseRow, 'management')
  const attorneyJury = getAttorneySection(caseRow, 'jury')
  const attorneyClose = getAttorneySection(caseRow, 'close')
  const attorneyDefendant = getAttorneySection(caseRow, 'defendant')
  const unreadMessageCount = messageRows.filter((message) => {
    if (message.sender_user_id === user.id) return false
    if (!Number.isFinite(viewerLastSeenMs)) return true
    const createdMs = Date.parse(message.created_at)
    if (Number.isNaN(createdMs)) return false
    return createdMs > viewerLastSeenMs
  }).length
  const openTaskCount = taskRows.filter((task) => ['OPEN', 'PENDING'].includes(String(task.status).toUpperCase())).length
  const documentIssueCount = docsWithLinks.filter((doc) => {
    const status = String(doc.ocr_status ?? '').toUpperCase()
    return status === 'FAILED' || status === 'LOW_CONFIDENCE'
  }).length
  const canRequestAttorneyQuote = isStaffRole(role) || role === 'AGENCY' || role === 'FLEET'
  const canRequestAttorneyUpdate = canRequestAttorneyQuote || role === 'DRIVER'
  const canRequestSignedDocument = isAttorneyRole(role) || isStaffRole(role)
  const canViewPricing = canViewerSeePricing({ role, userId: user.id, caseRow })
  const paymentTargetQuote = currentQuote ?? latestQuote
  const paymentHref = paymentTargetQuote ? `/checkout/${encodeURIComponent(paymentTargetQuote.id)}` : ''
  const nextActionLabel = getNextRequiredActionLabel({
    caseRow,
    openTaskCount,
    unreadMessageCount,
    currentQuote,
  })
  const routingStatusLabel = openPaymentRequest && canViewPricing && paymentTargetQuote
    ? `Payment due: ${formatUsd(openPaymentRequest.amount_cents || paymentTargetQuote.total_cents)}`
    : currentQuote && canViewPricing
      ? `Quote open for ${formatUsd(currentQuote.total_cents)}`
      : String(caseRow.payment_flow_status ?? '').trim().toUpperCase() === 'AWAITING_ATTORNEY_QUOTES'
        ? 'Quote requests sent to local attorneys'
        : pendingOutreachCount
          ? `${pendingOutreachCount} outreach candidates pending`
          : caseRow.attorney_firm_id
            ? 'Attorney firm assigned'
            : 'Awaiting attorney routing'
  const displayAttorneyFee = paymentTargetQuote?.attorney_fee_cents ?? caseRow.attorney_fee_cents ?? null
  const displayPlatformFee = paymentTargetQuote?.platform_fee_cents ?? caseRow.platform_fee_cents ?? null
  const displayTotal = paymentTargetQuote?.total_cents ?? caseRow.total_price_cents ?? null
  const pricingHiddenForViewer = Boolean(displayTotal) && !canViewPricing
  const paymentFlowLabel = formatFlowLabel(caseRow.payment_flow_status)
  const latestPaymentStatusLabel = latestPaymentRequest ? formatFlowLabel(latestPaymentRequest.status) : 'None'
  const showPayNowLink = Boolean(paymentHref && openPaymentRequest && canViewPricing && !isAttorneyRole(role))

  return (
    <div className="case-workspace">
      <Link href={backHref} style={{ textDecoration: 'none', color: '#0f4c81' }}>
        Back to Dashboard
      </Link>

      <h1 className="case-workspace-header">Case Details</h1>

      {query?.message ? (
        <p className="notice" style={{ marginTop: 0 }}>
          {query.message}
        </p>
      ) : null}

      <section className="case-summary-rail" aria-label="Matter summary">
        <article className="case-summary-card">
          <span className="case-summary-label">Matter Status</span>
          <strong>{caseRow.status}</strong>
          <span>{attorneyPrimaryStep ? `Workflow: ${attorneyPrimaryStep}` : caseSource.label}</span>
        </article>
        <article className="case-summary-card">
          <span className="case-summary-label">Next Hearing</span>
          <strong>{formatShortDateLabel(caseRow.court_date)}</strong>
          <span>{caseRow.court_name ?? `${caseRow.county ?? 'County'}, ${caseRow.state}`}</span>
        </article>
        <article className="case-summary-card">
          <span className="case-summary-label">Next Required Action</span>
          <strong>{nextActionLabel}</strong>
          <span>{submitterName ?? uploaderAccountName}</span>
        </article>
        <article className="case-summary-card">
          <span className="case-summary-label">Routing & Billing</span>
          <strong>{routingStatusLabel}</strong>
          <span>{caseRow.attorney_firm_id ? firmNameById.get(caseRow.attorney_firm_id) || caseRow.attorney_firm_id : 'No firm assigned'}</span>
        </article>
      </section>

      <div className="case-layout">
        <aside className="case-side-nav card" aria-label="Case section navigation">
          <p className="case-side-nav-title">Case Navigation</p>
          <a href="#case-messages" className="case-side-link">
            <span>Communications</span>
            <span className={`case-side-pill${unreadMessageCount ? ' is-alert' : ''}`}>
              {unreadMessageCount}
            </span>
          </a>
          <a href="#case-overview" className="case-side-link">
            <span>Overview</span>
          </a>
          <a href="#case-actions" className="case-side-link">
            <span>Actions</span>
          </a>
          <a href="#case-activity" className="case-side-link">
            <span>Activity Log</span>
            <span className="case-side-pill">{eventRows.length}</span>
          </a>
          {isAttorneyRole(role) ? (
            <>
              <a href="#attorney-workflow" className="case-side-link">
                <span>Workflow</span>
                <span className="case-side-pill">{completedStepCount}</span>
              </a>
              <a href="#attorney-management" className="case-side-link">
                <span>Notes & Forms</span>
              </a>
            </>
          ) : null}
          <a href="#case-tasks" className="case-side-link">
            <span>Tasks</span>
            <span className={`case-side-pill${openTaskCount ? ' is-alert' : ''}`}>{openTaskCount}</span>
          </a>
          <a href="#case-documents" className="case-side-link">
            <span>Documents</span>
            <span className={`case-side-pill${documentIssueCount ? ' is-alert' : ''}`}>{docsWithLinks.length}</span>
          </a>
        </aside>

        <main className="case-main-content">
      <section className="case-quick-strip" style={{ marginBottom: 14 }}>
        <Link href="#case-messages" className={`case-anchor-badge${unreadMessageCount ? ' is-alert' : ''}`}>
          Communications
          <strong>{unreadMessageCount} unread</strong>
        </Link>
        <Link href="#case-tasks" className={`case-anchor-badge${openTaskCount ? ' is-alert' : ''}`}>
          Tasks
          <strong>{openTaskCount} open</strong>
        </Link>
        <Link href="#case-documents" className={`case-anchor-badge${documentIssueCount ? ' is-alert' : ''}`}>
          Documents
          <strong>{docsWithLinks.length} files</strong>
        </Link>
        <Link href="#case-activity" className="case-anchor-badge">
          Activity
          <strong>{eventRows.length} events</strong>
        </Link>
      </section>

	      <details className="card case-collapsible case-chat-shell" open style={{ marginBottom: 14 }} id="case-messages">
	        <summary>Attorney Chat and Coordination</summary>
        <section className="grid-2" style={{ marginBottom: 0 }}>
          <div className="card" style={{ boxShadow: 'none' }}>
            <h2 style={{ marginTop: 0 }}>Case Chat</h2>

            <form action={sendCaseMessage} style={{ display: 'grid', gap: 8 }}>
              <input type="hidden" name="case_id" value={id} />
              <input type="hidden" name="return_to" value={caseSelfHref} />
              <div>
                <label htmlFor="recipient_role">Recipient role</label>
                <select id="recipient_role" name="recipient_role" defaultValue="">
                  <option value="">All Participants</option>
                  <option value="AGENCY">Agency</option>
                  <option value="FLEET">Fleet</option>
                  <option value="ATTORNEY">Attorney</option>
                  <option value="DRIVER">Driver</option>
                </select>
              </div>
              <div>
                <label htmlFor="message">Message</label>
                <textarea id="message" name="message" rows={4} required placeholder="Post a case update, request, or question." />
              </div>
              <button type="submit" className="primary">
                Send Message
              </button>
            </form>

            {messagesErr ? <p className="error" style={{ marginTop: 10 }}>Error loading messages: {messagesErr.message}</p> : null}

            {!messageRows.length ? (
              <p style={{ margin: '10px 0 0 0', color: '#586079' }}>No messages yet.</p>
            ) : (
              <ul className="case-chat-list">
                {messageRows.map((m) => (
                  <li key={m.id} className="case-chat-item">
                    <p style={{ margin: 0 }}>{m.body}</p>
                    <p style={{ margin: '6px 0 0 0', fontSize: 13, color: '#586079' }}>
                      <strong>From:</strong> {senderLabel(m.sender_user_id, profileLookup, user.id)} |{' '}
                      <strong>To:</strong> {recipientRoleLabel(m.recipient_role)}
                    </p>
                    <p style={{ margin: '4px 0 0 0', fontSize: 13, color: '#586079' }}>
                      <strong>Sent:</strong> {new Date(m.created_at).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card" style={{ boxShadow: 'none' }}>
            <h2 style={{ marginTop: 0 }}>Coordination Actions</h2>

            {canRequestAttorneyQuote ? (
              <form action={requestAttorneyQuote} style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                <input type="hidden" name="case_id" value={id} />
                <input type="hidden" name="return_to" value={caseSelfHref} />
                <label htmlFor="quote-instructions">Request attorney quote</label>
                <input id="quote-instructions" name="instructions" placeholder="Any pricing or urgency context" />
                <button type="submit" className="secondary">
                  Request Quote
                </button>
              </form>
            ) : null}

            {canRequestAttorneyUpdate ? (
              <form action={requestAttorneyUpdate} style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                <input type="hidden" name="case_id" value={id} />
                <input type="hidden" name="return_to" value={caseSelfHref} />
                <label htmlFor="update-instructions">Request attorney update</label>
                <input id="update-instructions" name="instructions" placeholder="What do you need the attorney to clarify?" />
                <button type="submit" className="secondary">
                  Request Update
                </button>
              </form>
            ) : null}

            {canRequestSignedDocument ? (
              <form action={requestSignedDocument} style={{ display: 'grid', gap: 8 }}>
                <input type="hidden" name="case_id" value={id} />
                <input type="hidden" name="return_to" value={caseSelfHref} />
                <label htmlFor="signed-doc-instructions">Request signed documents (attorney/admin)</label>
                <input id="signed-doc-instructions" name="instructions" placeholder="Which document needs signature?" />
                <button type="submit" className="secondary">
                  Request Signature
                </button>
              </form>
            ) : null}

            {isAttorneyRole(role) ? (
              <div style={{ marginTop: 12, borderTop: '1px solid #dbe0ef', paddingTop: 12 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 18 }}>Invite Driver or Agency</h3>
                {!isAttorneyExternalSource ? (
                  <p style={{ margin: 0, color: '#586079', fontSize: 14 }}>
                    Invites from case view are enabled for attorney-uploaded external-source cases.
                  </p>
                ) : (
                  <form action={inviteCaseParticipant} style={{ display: 'grid', gap: 8 }}>
                    <input type="hidden" name="case_id" value={id} />
                    <input type="hidden" name="return_to" value={caseSelfHref} />
                    <div>
                      <label htmlFor="invite-email">Invite email</label>
                      <input id="invite-email" name="email" type="email" required placeholder="driver-or-agency@email.com" />
                    </div>
                    <div>
                      <label htmlFor="invite-role">Invite as</label>
                      <select id="invite-role" name="target_role" defaultValue="DRIVER">
                        <option value="DRIVER">Driver</option>
                        <option value="AGENCY">Agency</option>
                      </select>
                    </div>
                    <button type="submit" className="primary">
                      Send Invite
                    </button>
                  </form>
                )}
              </div>
            ) : null}
          </div>
        </section>
	      </details>

	      <section className="card" style={{ marginBottom: 14 }}>
	        <h2 style={{ marginTop: 0, marginBottom: 10 }}>Pricing and Payment</h2>
	        <div className="grid-2">
	          <article className="card" style={{ margin: 0 }}>
	            <h3 style={{ marginTop: 0 }}>Workflow Status</h3>
	            <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
	              <p style={{ margin: 0 }}>
	                <strong>Payment Flow:</strong> {paymentFlowLabel}
	              </p>
	              <p style={{ margin: 0 }}>
	                <strong>Pricing Available:</strong> {caseRow.pricing_available ? 'Yes' : 'No'}
	              </p>
	              <p style={{ margin: 0 }}>
	                <strong>Primary Contact:</strong> {getPrimaryContactLabel(caseRow)}
	              </p>
	              <p style={{ margin: 0 }}>
	                <strong>Show Pricing to Fleet/Driver:</strong>{' '}
	                {caseRow.show_paid_pricing_to_fleet_driver ? 'Yes' : 'No'}
	              </p>
	              <p style={{ margin: 0 }}>
	                <strong>Quote Requested:</strong> {formatDateTime(caseRow.quote_requested_at)}
	              </p>
	              <p style={{ margin: 0 }}>
	                <strong>Quote Received:</strong> {formatDateTime(caseRow.quote_received_at)}
	              </p>
	              <p style={{ margin: 0 }}>
	                <strong>Payment Request Sent:</strong> {formatDateTime(caseRow.payment_request_sent_at)}
	              </p>
	            </div>
	          </article>
	          <article className="card" style={{ margin: 0 }}>
	            <h3 style={{ marginTop: 0 }}>Submitter Billing</h3>
	            {pricingHiddenForViewer ? (
	              <p style={{ margin: 0, color: '#586079' }}>
	                Pricing is hidden on fleet and driver views for this case. Contact the primary case contact or your agency for billing details.
	              </p>
	            ) : displayTotal ? (
	              <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
	                <p style={{ margin: 0 }}>
	                  <strong>Attorney Fee:</strong> {formatUsd(displayAttorneyFee)}
	                </p>
	                <p style={{ margin: 0 }}>
	                  <strong>Platform Fee:</strong> {formatUsd(displayPlatformFee)}
	                </p>
	                <p style={{ margin: 0 }}>
	                  <strong>Total Due:</strong> {formatUsd(displayTotal)}
	                </p>
	                <p style={{ margin: 0 }}>
	                  <strong>Payment Request:</strong> {latestPaymentStatusLabel}
	                </p>
	                {latestPaymentRequest?.request_email ? (
	                  <p style={{ margin: 0 }}>
	                    <strong>Requested From:</strong> {latestPaymentRequest.request_email}
	                  </p>
	                ) : null}
	                {latestPaymentRequest?.due_at ? (
	                  <p style={{ margin: 0 }}>
	                    <strong>Due:</strong> {formatDateTime(latestPaymentRequest.due_at)}
	                  </p>
	                ) : null}
	                {showPayNowLink ? (
	                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
	                    <Link href={paymentHref} className="button-link primary">
	                      Pay Now
	                    </Link>
	                    <Link href={`#case-activity`} className="button-link secondary">
	                      View Payment Activity
	                    </Link>
	                  </div>
	                ) : null}
	              </div>
	            ) : String(caseRow.payment_flow_status ?? '').trim().toUpperCase() === 'AWAITING_ATTORNEY_QUOTES' ? (
	              <p style={{ margin: 0, color: '#586079' }}>
	                Local attorneys are being asked to quote this case. Pricing will appear here after a fee is submitted.
	              </p>
	            ) : (
	              <p style={{ margin: 0, color: '#586079' }}>
	                Pricing has not been finalized for this case yet.
	              </p>
	            )}
	          </article>
	        </div>
	      </section>

	      <section id="case-overview" className="grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2 style={{ marginTop: 0, marginBottom: 10 }}>Case Information</h2>

	          <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
	            <p style={{ margin: 0 }}>
	              <strong>Driver Name:</strong> {getCaseDisplayDriverName(caseRow)}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>State:</strong> {caseRow.state}
	            </p>
            <p style={{ margin: 0 }}>
              <strong>County:</strong> {caseRow.county ?? '-'}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Citation:</strong> {caseRow.citation_number ?? '-'}
            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Violation Code:</strong> {caseRow.violation_code ?? '-'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Violation Date:</strong> {getCaseViolationDate(caseRow) ?? '-'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Court Name:</strong> {caseRow.court_name ?? '-'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Court Date:</strong> {caseRow.court_date ?? 'Not set'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Court Case Number:</strong> {getCaseCourtCaseNumber(caseRow) ?? '-'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Attorney Updated:</strong> {getCaseAttorneyUpdateDate(caseRow) ?? '-'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Status:</strong> <span className="badge">{caseRow.status}</span>
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Source:</strong> {caseSource.label}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Submitter Name:</strong> {submitterName ?? '-'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Submitter Email:</strong> {submitterEmail ?? '-'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Submitter Phone:</strong> {submitterPhone ?? '-'}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Uploaded By Account:</strong> {uploaderAccountName}
	            </p>
	            <p style={{ margin: 0 }}>
	              <strong>Uploaded By Role:</strong> {uploaderRole}
	            </p>
	            {uploaderAccountEmail ? (
	              <p style={{ margin: 0 }}>
	                <strong>Uploader Email:</strong> {uploaderAccountEmail}
	              </p>
	            ) : null}
	            {isAttorneyRole(role) && attorneyPrimaryStep ? (
	              <p style={{ margin: 0 }}>
	                <strong>Attorney Step:</strong> <span className="badge">{attorneyPrimaryStep}</span>
              </p>
            ) : null}
            <p style={{ margin: 0 }}>
              <strong>Agency Scope:</strong> {currentAgencyName ?? caseRow.agency_id ?? 'Personal / not linked'}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Fleet Monitoring:</strong> {currentCaseFleet?.company_name ?? 'Not linked to a fleet'}
            </p>
            {role === 'DRIVER' && driverLinkedFleetNames.length ? (
              <p style={{ margin: 0 }}>
                <strong>Your Linked Fleets:</strong> {formatCommaList(driverLinkedFleetNames)}
              </p>
            ) : null}
            <p style={{ margin: 0 }}>
              <strong>Created:</strong>{' '}
              {new Date(caseRow.created_at).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Last Updated:</strong>{' '}
              {new Date(caseRow.updated_at).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Notes:</strong> {deriveNotes(caseRow)}
            </p>
          </div>
        </div>

        <div className="card" id="case-actions">
          <h2 style={{ marginTop: 0, marginBottom: 10 }}>Case Actions</h2>

          {showDriverFleetMonitoringControls ? (
            <>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <h3 style={{ margin: '0 0 6px 0', fontSize: 18 }}>Fleet Monitoring</h3>
                  <p style={{ margin: 0, color: '#586079', fontSize: 14 }}>
                    Control whether this case is visible to your linked fleet workspace and confirm who is currently monitoring it.
                  </p>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gap: 8,
                    padding: 12,
                    border: '1px solid #dbe0ef',
                    borderRadius: 12,
                    background: '#f7f8fb',
                    fontSize: 14,
                  }}
                >
                  <p style={{ margin: 0 }}>
                    <strong>Agency Share:</strong> {currentAgencyName ?? caseRow.agency_id ?? 'No agency linked'}
                  </p>
                  <p style={{ margin: 0 }}>
                    <strong>Fleet Share:</strong> {currentCaseFleet?.company_name ?? 'No fleet currently monitoring this case'}
                  </p>
                </div>
                <form action={updateDriverCaseFleetMonitoring} style={{ display: 'grid', gap: 10 }}>
                  <input type="hidden" name="case_id" value={caseRow.id} />
                  <input type="hidden" name="return_to" value={caseSelfHref} />
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input name="share_with_fleet" type="checkbox" value="1" defaultChecked={Boolean(caseRow.fleet_id)} />
                    Keep this case shared with a fleet monitor
                  </label>
                  {driverMonitoringFleetOptions.length ? (
                    <div>
                      <label htmlFor="driver-monitoring-fleet">Fleet</label>
                      <select id="driver-monitoring-fleet" name="fleet_id" defaultValue={driverFleetSelectValue}>
                        {driverMonitoringFleetOptions.map((fleet) => (
                          <option key={fleet.id} value={fleet.id}>
                            {fleet.company_name}
                            {fleet.is_active === false ? ' (Archived)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <p style={{ margin: 0, color: '#586079', fontSize: 14 }}>
                      No linked fleets are available for reassignment on this case right now.
                    </p>
                  )}
                  <button type="submit" className="secondary">
                    Save Fleet Monitoring
                  </button>
                </form>
                {driverCanInviteFleetMonitor ? (
                  <form action={inviteFleetMonitorForCase} style={{ display: 'grid', gap: 10 }}>
                    <input type="hidden" name="case_id" value={caseRow.id} />
                    <input type="hidden" name="return_to" value={caseSelfHref} />
                    {driverMonitoringFleetOptions.length ? (
                      <div>
                        <label htmlFor="fleet-monitor-invite-fleet">Invite into Fleet Scope</label>
                        <select id="fleet-monitor-invite-fleet" name="fleet_id" defaultValue={driverFleetSelectValue}>
                          {driverMonitoringFleetOptions.map((fleet) => (
                            <option key={fleet.id} value={fleet.id}>
                              {fleet.company_name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <p style={{ margin: 0, color: '#586079', fontSize: 14 }}>
                        This invite will use the current agency scope on the case because no specific fleet is selected.
                      </p>
                    )}
                    <div>
                      <label htmlFor="fleet-monitor-email">Invite fleet monitor by email</label>
                      <input
                        id="fleet-monitor-email"
                        name="email"
                        type="email"
                        required
                        placeholder="fleet-monitor@example.com"
                      />
                    </div>
                    <button type="submit" className="secondary">
                      Send Fleet Invite
                    </button>
                  </form>
                ) : driverOwnsCase ? (
                  <p style={{ margin: 0, color: '#586079', fontSize: 14 }}>
                    Link this case to an agency or fleet first before inviting a fleet monitor by email.
                  </p>
                ) : null}
              </div>
              <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />
            </>
          ) : driverOwnsCase ? (
            <>
              <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 18 }}>Fleet Monitoring</h3>
                <p style={{ margin: 0, color: '#586079', fontSize: 14 }}>
                  This case is currently private to your driver workspace. No linked fleet is available for sharing yet.
                </p>
              </div>
              <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />
            </>
          ) : null}

          {role !== 'DRIVER' ? (
            <form action={updateCaseStatus} style={{ display: 'grid', gap: 10 }}>
              <input type="hidden" name="case_id" value={caseRow.id} />
              <input type="hidden" name="return_to" value={caseSelfHref} />
              <div>
                <label htmlFor="status">Update status</label>
                <select
                  id="status"
                  name="status"
                  defaultValue={caseRow.status}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #dbe0ef' }}
                >
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="primary">
                Save Status
              </button>
            </form>
          ) : null}

          <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />

		          <form action={updateCaseNextCourtDate} style={{ display: 'grid', gap: 10 }}>
		            <input type="hidden" name="case_id" value={caseRow.id} />
		            <input type="hidden" name="return_to" value={caseSelfHref} />
            <div>
              <label htmlFor="next_court_date">Next court date</label>
              <input id="next_court_date" name="next_court_date" type="date" defaultValue={caseRow.court_date ?? ''} />
            </div>
		            <button type="submit" className="secondary">
		              Save Next Court Date
		            </button>
		          </form>

	              {(isAttorneyRole(role) || isStaffRole(role)) && canUseAttorneyCalendar ? (
                <>
                  <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />
	                  <div style={{ display: 'grid', gap: 12 }}>
                    <div>
                      <h3 style={{ margin: '0 0 6px 0', fontSize: 18 }}>Calendar Shortcuts</h3>
                      <p style={{ margin: 0, color: '#586079', fontSize: 14 }}>
                        Schedule hearing work, create a follow-up reminder, or jump directly into the case calendar view.
                      </p>
                    </div>
                    <form action={addCaseHearingShortcut} style={{ display: 'grid', gap: 8 }}>
                      <input type="hidden" name="case_id" value={caseRow.id} />
                      <input type="hidden" name="return_to" value={caseSelfHref} />
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(160px,220px)', gap: 8 }}>
                        <div>
                          <label htmlFor="hearing_date">Add Hearing</label>
                          <input id="hearing_date" name="hearing_date" type="date" defaultValue={caseRow.court_date ?? ''} required />
                        </div>
                        <div>
                          <label htmlFor="hearing_time">Time</label>
                          <input id="hearing_time" name="hearing_time" type="time" defaultValue={caseRow.court_time ?? '09:00'} />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="hearing_title">Hearing title</label>
                        <input
                          id="hearing_title"
                          name="title"
                          placeholder={caseRow.court_name || 'Hearing'}
                          defaultValue={caseRow.court_name ?? ''}
                        />
                      </div>
                      <button type="submit" className="secondary">
                        Add Hearing
                      </button>
                    </form>
                    <form action={addCaseFollowUpShortcut} style={{ display: 'grid', gap: 8 }}>
                      <input type="hidden" name="case_id" value={caseRow.id} />
                      <input type="hidden" name="return_to" value={caseSelfHref} />
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(160px,220px)', gap: 8 }}>
                        <div>
                          <label htmlFor="follow_up_date">Add Follow-Up</label>
                          <input id="follow_up_date" name="follow_up_date" type="date" required />
                        </div>
                        <div>
                          <label htmlFor="follow_up_time">Time</label>
                          <input id="follow_up_time" name="follow_up_time" type="time" defaultValue="09:00" />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="follow_up_title">Follow-up title</label>
                        <input
                          id="follow_up_title"
                          name="title"
                          placeholder="Follow up after court appearance"
                          defaultValue="Follow up after court appearance"
                        />
                      </div>
                      <button type="submit" className="secondary">
                        Add Follow-Up
                      </button>
                    </form>
                    <Link href={caseCalendarHref} className="button-link ghost">
                      Open Case Calendar
                    </Link>
                  </div>
                </>
	              ) : (isAttorneyRole(role) || isStaffRole(role)) ? (
                  <>
                    <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />
                    <p className="notice" style={{ marginBottom: 0 }}>
                      Calendar shortcuts are disabled for this role.
                    </p>
                  </>
                ) : null}

			          {isStaffRole(role) ? (
			            <>
		              <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />
		              <div style={{ display: 'grid', gap: 12 }}>
	                <div>
	                  <h3 style={{ margin: '0 0 6px 0', fontSize: 18 }}>Attorney Matching</h3>
	                  <p style={{ margin: 0, color: '#586079', fontSize: 14 }}>
	                    Run automatic pricing and outreach, or assign a firm manually from this case view.
	                  </p>
	                </div>
	                <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
	                  <p style={{ margin: 0 }}>
	                    <strong>Current Quote:</strong> {currentQuote ? formatUsd(currentQuote.total_cents) : 'None'}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Matched Firm:</strong>{' '}
	                    {caseRow.attorney_firm_id ? firmNameById.get(caseRow.attorney_firm_id) || caseRow.attorney_firm_id : 'Unassigned'}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Pending Outreach:</strong> {pendingOutreachCount}
	                  </p>
	                </div>
		                {canRunAutoAttorneyMatching ? (
		                <form action={adminRunAttorneyMatching} style={{ display: 'grid', gap: 8 }}>
		                  <input type="hidden" name="redirect_to" value={caseSelfHref} />
		                  <input type="hidden" name="case_id" value={caseRow.id} />
		                  <button type="submit" className="primary">
		                    Run Automatic Matching
		                  </button>
		                </form>
                    ) : (
                      <p className="notice" style={{ margin: 0 }}>Automatic attorney matching is disabled for your role.</p>
                    )}
		                {canRunManualAttorneyMatching ? (
		                <form action={adminCreateManualAttorneyMatch} style={{ display: 'grid', gap: 8 }}>
	                  <input type="hidden" name="redirect_to" value={caseSelfHref} />
	                  <input type="hidden" name="case_id" value={caseRow.id} />
	                  <div>
	                    <label htmlFor="manual_match_firm_id">Attorney firm</label>
	                    <select id="manual_match_firm_id" name="firm_id" defaultValue={caseRow.attorney_firm_id ?? ''} required>
	                      <option value="" disabled>
	                        Select a firm
	                      </option>
	                      {attorneyFirms.map((firm) => {
	                        const pricing = pricingByFirmId.get(firm.id)
	                        return (
	                          <option key={firm.id} value={firm.id}>
	                            {firm.company_name}
	                            {pricing ? ` | CDL ${formatUsd(pricing.cdl_fee_cents)}` : ''}
	                          </option>
	                        )
	                      })}
	                    </select>
	                  </div>
	                  <div>
	                    <label htmlFor="manual_match_fee">Attorney fee (USD)</label>
	                    <input
	                      id="manual_match_fee"
	                      name="attorney_fee_dollars"
	                      type="number"
	                      min="0"
	                      step="0.01"
	                      defaultValue={
	                        currentQuote
	                          ? (Number(currentQuote.attorney_fee_cents) / 100).toFixed(2)
	                          : pricingRows[0]
	                            ? (Number(pricingRows[0].cdl_fee_cents) / 100).toFixed(2)
	                            : ''
	                      }
	                      placeholder="1500.00"
	                      required
	                    />
	                  </div>
	                  <button type="submit" className="secondary" disabled={!attorneyFirms.length}>
	                    Create Manual Match
	                  </button>
	                  {!attorneyFirms.length ? (
	                    <p style={{ margin: 0, color: '#586079', fontSize: 13 }}>
	                      No active attorney firms are available yet for manual matching.
	                    </p>
	                  ) : null}
		                </form>
                    ) : (
                      <p className="notice" style={{ margin: 0 }}>Manual attorney matching is disabled for your role.</p>
                    )}
		              </div>
		            </>
		          ) : null}

	          {isAttorneyRole(role) ? (
	            <>
	              <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />
	              <form action={updateAttorneyCaseTracking} style={{ display: 'grid', gap: 10 }}>
	                <input type="hidden" name="case_id" value={caseRow.id} />
	                <input type="hidden" name="return_to" value={caseSelfHref} />
	                <div>
	                  <label htmlFor="case_court_case_number">Court case number</label>
	                  <input
	                    id="case_court_case_number"
	                    name="court_case_number"
	                    defaultValue={getCaseCourtCaseNumber(caseRow) ?? ''}
	                    placeholder="Court docket or reference number"
	                  />
	                </div>
	                <div>
	                  <label htmlFor="case_attorney_update_date">Updated date</label>
	                  <input
	                    id="case_attorney_update_date"
	                    name="attorney_update_date"
	                    type="date"
	                    defaultValue={String(getCaseAttorneyUpdateDate(caseRow) ?? '').slice(0, 10)}
	                  />
	                </div>
	                <button type="submit" className="secondary">
	                  Save Court Tracking
	                </button>
	              </form>
	            </>
	          ) : null}

	          {isAttorneyRole(role) ? (
	            <>
              <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />
              <form action={requestCasePayment} style={{ display: 'grid', gap: 10 }}>
                <input type="hidden" name="case_id" value={caseRow.id} />
                <div>
                  <label htmlFor="case_payment_source">Request payment from</label>
                  <select id="case_payment_source" name="source" defaultValue="DIRECT_CLIENT">
                    <option value="DIRECT_CLIENT">Direct Client</option>
                    <option value="CDL_PROTECT">CDL Protect</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="case_payment_amount">Amount (USD)</label>
                  <input id="case_payment_amount" name="amount" type="number" min="0.01" step="0.01" required />
                </div>
                <div>
                  <label htmlFor="case_payment_notes">Notes</label>
                  <input id="case_payment_notes" name="notes" placeholder="Optional payment memo" />
                </div>
                <button type="submit" className="secondary">
                  Request Payment
                </button>
              </form>
            </>
          ) : null}

          {isAttorneyRole(role) ? (
            <>
              <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />
              <form action={setAttorneyPrimaryStep} style={{ display: 'grid', gap: 10 }}>
                <input type="hidden" name="case_id" value={caseRow.id} />
                <input type="hidden" name="return_to" value={caseSelfHref} />
                <div>
                  <label htmlFor="primary_step">Attorney step</label>
                  <select
                    id="primary_step"
                    name="primary_step"
                    defaultValue={attorneyPrimaryStep}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #dbe0ef' }}
                  >
                    <option value="" disabled>
                      Select attorney step
                    </option>
                    {ATTORNEY_WORKFLOW_STEPS.map((step) => (
                      <option key={step} value={step}>
                        {step}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="secondary">
                  Save Attorney Step
                </button>
              </form>
            </>
          ) : null}

          <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #dbe0ef' }} />

          <form action={uploadCaseDocument} style={{ display: 'grid', gap: 10 }}>
            <input type="hidden" name="case_id" value={caseRow.id} />
            <input type="hidden" name="return_to" value={caseSelfHref} />
            <div>
              <label htmlFor="doc_type">Document type</label>
              <select id="doc_type" name="doc_type" defaultValue="POLICE_REPORT">
                <option value="POLICE_REPORT">Police Report / Ticket</option>
                <option value="MVR">MVR (Driving Record)</option>
                <option value="DRIVERS_LICENSE">Driver&apos;s License</option>
                <option value="CRASH_REPORT">Crash Report</option>
                <option value="EVIDENCE">Other Evidence</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div>
              <label htmlFor="document">File (max 10MB)</label>
              <input id="document" name="document" type="file" required />
            </div>
            <button type="submit" className="secondary">
              Upload + OCR
            </button>
          </form>
        </div>
      </section>

      <details className="card case-collapsible" open id="case-activity">
        <summary>Activity Timeline</summary>

        {eventsErr ? <p className="error">Error loading activity: {eventsErr.message}</p> : null}

        {!(events ?? []).length ? (
          <p style={{ marginBottom: 0, color: '#586079' }}>No activity recorded yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {(events as CaseEvent[]).map((e) => (
              <li key={e.id} style={{ border: '1px solid #dbe0ef', borderRadius: 10, padding: 10 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>{e.event_summary}</p>
                <p style={{ margin: '4px 0 0 0', fontSize: 13, color: '#586079' }}>
                  {e.event_type} | {new Date(e.created_at).toLocaleString()} | Actor: {e.actor_id ?? 'unknown'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>

      {isAttorneyRole(role) ? (
        <details className="card case-collapsible" open style={{ marginBottom: 14 }} id="attorney-workflow">
          <summary>Attorney Workflow Steps ({completedStepCount}/{ATTORNEY_WORKFLOW_STEPS.length})</summary>
          <p style={{ marginTop: 0, color: '#586079', fontSize: 14 }}>
            Use this checklist to track practical case progress for traffic-ticket handling.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 8,
            }}
          >
            {ATTORNEY_WORKFLOW_STEPS.map((step) => {
              const isDone = completedSteps.has(step)
              return (
                <form
                  key={step}
                  action={toggleAttorneyWorkflowStep}
                  style={{
                    border: '1px solid #dbe0ef',
                    borderRadius: 10,
                    padding: 10,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    background: isDone ? '#f7f8fb' : '#fff',
                  }}
                >
                  <input type="hidden" name="case_id" value={caseRow.id} />
                  <input type="hidden" name="step_key" value={step} />
                  <input type="hidden" name="done" value={isDone ? '0' : '1'} />
                  <input type="hidden" name="return_to" value={caseSelfHref} />
                  <span style={{ fontSize: 14, fontWeight: isDone ? 700 : 500 }}>
                    {isDone ? '[done] ' : ''}
                    {step}
                  </span>
                  <button type="submit" className={isDone ? 'secondary' : 'primary'}>
                    {isDone ? 'Undo' : 'Done'}
                  </button>
                </form>
              )
            })}
          </div>
        </details>
      ) : null}

      {isAttorneyRole(role) ? (
        <>
          <details className="card case-collapsible" style={{ marginBottom: 14 }} open id="attorney-management">
            <summary>Attorney Case and Defendant</summary>
            <section
              className="case-dual-grid"
              style={{ marginBottom: 0 }}
            >
            <div className="card">
              <h2 style={{ marginTop: 0, marginBottom: 10 }}>Attorney Case Management</h2>
              <form action={saveAttorneyCaseSection} style={{ display: 'grid', gap: 10 }}>
                <input type="hidden" name="case_id" value={caseRow.id} />
                <input type="hidden" name="section" value="management" />
                <input type="hidden" name="return_to" value={caseSelfHref} />
                <div
                  style={{
                    display: 'grid',
                    gap: 10,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  }}
                >
                  <div>
                    <label htmlFor="entry_method">Entry method</label>
                    <input id="entry_method" name="entry_method" defaultValue={readSectionText(attorneyManagement, 'entry_method')} />
                  </div>
                  <div>
                    <label htmlFor="offer_request_method">Offer request method</label>
                    <input
                      id="offer_request_method"
                      name="offer_request_method"
                      defaultValue={readSectionText(attorneyManagement, 'offer_request_method')}
                    />
                  </div>
                  <div>
                    <label htmlFor="offer_requested_date">Offer requested date</label>
                    <input
                      id="offer_requested_date"
                      name="offer_requested_date"
                      type="date"
                      defaultValue={readSectionText(attorneyManagement, 'offer_requested_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="offer_delivered_date">Offer delivered date</label>
                    <input
                      id="offer_delivered_date"
                      name="offer_delivered_date"
                      type="date"
                      defaultValue={readSectionText(attorneyManagement, 'offer_delivered_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="guilty_plea_date">Guilty plea date</label>
                    <input
                      id="guilty_plea_date"
                      name="guilty_plea_date"
                      type="date"
                      defaultValue={readSectionText(attorneyManagement, 'guilty_plea_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="continuance_date">Continuance date</label>
                    <input
                      id="continuance_date"
                      name="continuance_date"
                      type="date"
                      defaultValue={readSectionText(attorneyManagement, 'continuance_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="continuance_reason">Continuance reason</label>
                    <input
                      id="continuance_reason"
                      name="continuance_reason"
                      defaultValue={readSectionText(attorneyManagement, 'continuance_reason')}
                    />
                  </div>
                  <div>
                    <label htmlFor="continuance_reason_other">Continuance reason other</label>
                    <input
                      id="continuance_reason_other"
                      name="continuance_reason_other"
                      defaultValue={readSectionText(attorneyManagement, 'continuance_reason_other')}
                    />
                  </div>
                  <div>
                    <label htmlFor="pending_reason">Pending reason</label>
                    <input id="pending_reason" name="pending_reason" defaultValue={readSectionText(attorneyManagement, 'pending_reason')} />
                  </div>
                  <div>
                    <label htmlFor="interpreter">Interpreter</label>
                    <input id="interpreter" name="interpreter" defaultValue={readSectionText(attorneyManagement, 'interpreter')} />
                  </div>
                  <div>
                    <label htmlFor="documents_needed">Documents needed</label>
                    <input
                      id="documents_needed"
                      name="documents_needed"
                      defaultValue={readSectionText(attorneyManagement, 'documents_needed')}
                    />
                  </div>
                  <div>
                    <label htmlFor="documents_received">Documents received</label>
                    <input
                      id="documents_received"
                      name="documents_received"
                      defaultValue={readSectionText(attorneyManagement, 'documents_received')}
                    />
                  </div>
                  <div>
                    <label htmlFor="client_meetings_count">Client meetings count</label>
                    <input
                      id="client_meetings_count"
                      name="client_meetings_count"
                      type="number"
                      min={0}
                      defaultValue={readSectionText(attorneyManagement, 'client_meetings_count')}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input name="offer_accepted" type="checkbox" defaultChecked={readSectionBool(attorneyManagement, 'offer_accepted')} />
                    Offer accepted
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input name="offer_rejected" type="checkbox" defaultChecked={readSectionBool(attorneyManagement, 'offer_rejected')} />
                    Offer rejected
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input name="questions" type="checkbox" defaultChecked={readSectionBool(attorneyManagement, 'questions')} />
                    Questions
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input name="no_court_date" type="checkbox" defaultChecked={readSectionBool(attorneyManagement, 'no_court_date')} />
                    No court date
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input name="appear" type="checkbox" defaultChecked={readSectionBool(attorneyManagement, 'appear')} />
                    Appear
                  </label>
                </div>
                <button type="submit" className="primary">
                  Save Case Management
                </button>
              </form>
            </div>

            <div className="card">
              <h2 style={{ marginTop: 0, marginBottom: 10 }}>Defendant</h2>
              <form action={saveAttorneyCaseSection} style={{ display: 'grid', gap: 10 }}>
                <input type="hidden" name="case_id" value={caseRow.id} />
                <input type="hidden" name="section" value="defendant" />
                <input type="hidden" name="return_to" value={caseSelfHref} />
                <div
                  style={{
                    display: 'grid',
                    gap: 10,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  }}
                >
                  <div>
                    <label htmlFor="defendant_name">Name</label>
                    <input id="defendant_name" name="name" defaultValue={readSectionText(attorneyDefendant, 'name')} />
                  </div>
                  <div>
                    <label htmlFor="defendant_phone">Phone</label>
                    <input id="defendant_phone" name="phone" defaultValue={readSectionText(attorneyDefendant, 'phone')} />
                  </div>
                  <div>
                    <label htmlFor="defendant_email">Email</label>
                    <input id="defendant_email" name="email" defaultValue={readSectionText(attorneyDefendant, 'email')} />
                  </div>
                  <div>
                    <label htmlFor="defendant_birthday">Birthday</label>
                    <input id="defendant_birthday" name="birthday" defaultValue={readSectionText(attorneyDefendant, 'birthday')} />
                  </div>
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <input name="has_cdl" type="checkbox" defaultChecked={readSectionBool(attorneyDefendant, 'has_cdl')} />
                  Has CDL
                </label>
                <div>
                  <label htmlFor="defendant_note">Note</label>
                  <textarea id="defendant_note" name="note" rows={4} defaultValue={readSectionText(attorneyDefendant, 'note')} />
                </div>
                <button type="submit" className="primary">
                  Save Defendant
                </button>
              </form>
            </div>
            </section>
          </details>

          <details className="card case-collapsible" style={{ marginBottom: 14 }} open>
            <summary>Jury Trial and Close Case</summary>
            <section
              className="case-dual-grid"
              style={{ marginBottom: 0 }}
            >
            <div className="card">
              <h2 style={{ marginTop: 0, marginBottom: 10 }}>Jury Trial Case Management</h2>
              <form action={saveAttorneyCaseSection} style={{ display: 'grid', gap: 10 }}>
                <input type="hidden" name="case_id" value={caseRow.id} />
                <input type="hidden" name="section" value="jury" />
                <input type="hidden" name="return_to" value={caseSelfHref} />
                <div
                  style={{
                    display: 'grid',
                    gap: 10,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  }}
                >
                  <div>
                    <label htmlFor="jury_trial_demand_date">Jury trial demand</label>
                    <input
                      id="jury_trial_demand_date"
                      name="jury_trial_demand_date"
                      type="date"
                      defaultValue={readSectionText(attorneyJury, 'jury_trial_demand_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="trial_date">Trial date</label>
                    <input id="trial_date" name="trial_date" type="date" defaultValue={readSectionText(attorneyJury, 'trial_date')} />
                  </div>
                  <div>
                    <label htmlFor="trial_setting_date">Trial setting</label>
                    <input
                      id="trial_setting_date"
                      name="trial_setting_date"
                      type="date"
                      defaultValue={readSectionText(attorneyJury, 'trial_setting_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="state_discovery_requested_date">State discovery requested</label>
                    <input
                      id="state_discovery_requested_date"
                      name="state_discovery_requested_date"
                      type="date"
                      defaultValue={readSectionText(attorneyJury, 'state_discovery_requested_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="provided_discovery_date">Provided discovery date</label>
                    <input
                      id="provided_discovery_date"
                      name="provided_discovery_date"
                      type="date"
                      defaultValue={readSectionText(attorneyJury, 'provided_discovery_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="pretrial_conference_date">Pretrial conference date</label>
                    <input
                      id="pretrial_conference_date"
                      name="pretrial_conference_date"
                      type="date"
                      defaultValue={readSectionText(attorneyJury, 'pretrial_conference_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="client_discovery_requested_date">Client discovery requested</label>
                    <input
                      id="client_discovery_requested_date"
                      name="client_discovery_requested_date"
                      type="date"
                      defaultValue={readSectionText(attorneyJury, 'client_discovery_requested_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="state_discovery_received_date">State discovery received</label>
                    <input
                      id="state_discovery_received_date"
                      name="state_discovery_received_date"
                      type="date"
                      defaultValue={readSectionText(attorneyJury, 'state_discovery_received_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="received_date">Received date</label>
                    <input
                      id="received_date"
                      name="received_date"
                      type="date"
                      defaultValue={readSectionText(attorneyJury, 'received_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="cop_depo_date">Cop depo date</label>
                    <input id="cop_depo_date" name="cop_depo_date" type="date" defaultValue={readSectionText(attorneyJury, 'cop_depo_date')} />
                  </div>
                </div>
                <div>
                  <label htmlFor="jury_interpreter">Interpreter</label>
                  <input id="jury_interpreter" name="interpreter" defaultValue={readSectionText(attorneyJury, 'interpreter')} />
                </div>
                <button type="submit" className="primary">
                  Save Jury Trial Section
                </button>
              </form>
            </div>

            <div className="card">
              <h2 style={{ marginTop: 0, marginBottom: 10 }}>Close Case</h2>
              <form action={saveAttorneyCaseSection} style={{ display: 'grid', gap: 10 }}>
                <input type="hidden" name="case_id" value={caseRow.id} />
                <input type="hidden" name="section" value="close" />
                <input type="hidden" name="return_to" value={caseSelfHref} />
                <div
                  style={{
                    display: 'grid',
                    gap: 10,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  }}
                >
                  <div>
                    <label htmlFor="court_fine_payment_mailed_date">Court fine payment mailed date</label>
                    <input
                      id="court_fine_payment_mailed_date"
                      name="court_fine_payment_mailed_date"
                      type="date"
                      defaultValue={readSectionText(attorneyClose, 'court_fine_payment_mailed_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="court_fine_payment_check_number">Court fine payment check number</label>
                    <input
                      id="court_fine_payment_check_number"
                      name="court_fine_payment_check_number"
                      defaultValue={readSectionText(attorneyClose, 'court_fine_payment_check_number')}
                    />
                  </div>
                  <div>
                    <label htmlFor="fedex_tracking_number">FedEx tracking number</label>
                    <input
                      id="fedex_tracking_number"
                      name="fedex_tracking_number"
                      defaultValue={readSectionText(attorneyClose, 'fedex_tracking_number')}
                    />
                  </div>
                  <div>
                    <label htmlFor="fedex_received_date">FedEx received date</label>
                    <input
                      id="fedex_received_date"
                      name="fedex_received_date"
                      type="date"
                      defaultValue={readSectionText(attorneyClose, 'fedex_received_date')}
                    />
                  </div>
                  <div>
                    <label htmlFor="payment_cashed_date">Payment cashed date</label>
                    <input
                      id="payment_cashed_date"
                      name="payment_cashed_date"
                      type="date"
                      defaultValue={readSectionText(attorneyClose, 'payment_cashed_date')}
                    />
                  </div>
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <input
                    name="close_case_in_broker_account"
                    type="checkbox"
                    defaultChecked={readSectionBool(attorneyClose, 'close_case_in_broker_account')}
                  />
                  Close case in OTR/Broker account
                </label>
                <button type="submit" className="primary">
                  Save Close Case Section
                </button>
              </form>
            </div>
            </section>
          </details>
        </>
      ) : null}

      <details className="card case-collapsible" style={{ marginBottom: 14 }} open id="case-tasks">
        <summary>Workflow Tasks</summary>

        {tasksErr ? <p className="error">Error loading tasks: {tasksErr.message}</p> : null}

        {!tasks?.length ? (
          <p style={{ marginBottom: 0, color: '#586079' }}>No workflow tasks yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {(tasks as CaseTask[]).map((task) => (
              <li key={task.id} style={{ border: '1px solid #dbe0ef', borderRadius: 10, padding: 10 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>
                  {task.task_type} <span className="badge">{task.status}</span>
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#586079', fontSize: 13 }}>
                  Target: {task.target_role || '-'} | Due:{' '}
                  {task.due_at
                    ? new Date(task.due_at).toLocaleString()
                    : 'Not set'}
                </p>
                {task.instructions ? (
                  <p style={{ margin: '6px 0 0 0', fontSize: 13 }}>{task.instructions}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="card case-collapsible" open id="case-documents">
        <summary>Documents</summary>

        {docsErr ? <p className="error">Error loading documents: {docsErr.message}</p> : null}

        {!docsWithLinks.length ? (
          <p style={{ marginBottom: 0, color: '#586079' }}>No documents uploaded yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {docsWithLinks.map((d) => (
              <li
                key={d.id}
                style={{
                  border: '1px solid #dbe0ef',
                  borderRadius: 10,
                  padding: 10,
                  display: 'grid',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div>
                    <strong>{d.doc_type}</strong>
                    <span> | {d.filename ?? '<unnamed>'}</span>
                    <span style={{ color: '#586079' }}>
                      {' '}
                      |{' '}
                      {new Date(d.created_at).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="badge">OCR: {d.ocr_status || 'UNKNOWN'}</span>
                    {d.signedUrl ? (
                      <a href={d.signedUrl} target="_blank" rel="noreferrer" className="button-link secondary">
                        Download
                      </a>
                    ) : null}
                    <form action={runDocumentOcrNow}>
                      <input type="hidden" name="case_id" value={id} />
                      <input type="hidden" name="document_id" value={d.id} />
                      <input type="hidden" name="return_to" value={caseSelfHref} />
                      <button type="submit" className="button-link secondary">
                        Run OCR
                      </button>
                    </form>
                  </div>
                </div>

                {d.ocr_extracted ? (
                  <pre
                    style={{
                      margin: 0,
                      padding: 10,
                      border: '1px solid #dbe0ef',
                      borderRadius: 8,
                      fontSize: 12,
                      overflowX: 'auto',
                      background: '#f7f8fb',
                    }}
                  >
                    {JSON.stringify(d.ocr_extracted, null, 2)}
                  </pre>
                ) : null}

                {d.ocr_status === 'FAILED' && deriveOcrError(d) ? (
                  <p style={{ margin: 0, color: '#a7423a', fontSize: 13 }}>
                    OCR error: {deriveOcrError(d)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </details>
        </main>
      </div>
    </div>
  )
}
