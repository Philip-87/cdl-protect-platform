import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { getAttorneyWorkspaceSummary, summarizeReminderRisk } from '@/app/attorney/lib/workspace'
import {
  getCaseAttorneyUpdateDate,
  getCaseCourtCaseNumber,
  getCaseDisplayDriverName,
  getCaseViolationDate,
} from '@/app/lib/cases/display'
import { ATTORNEY_CASE_STATUSES, CASE_STATUSES } from '@/app/lib/case-status'
import { createClient } from '@/app/lib/supabase/server'
import { hydrateCaseDriverNames } from '@/app/lib/server/case-driver-display'
import { acceptCaseOffer, declineCaseOffer, requestCasePayment, setCaseDisposition } from '@/app/dashboard/actions'
import {
  updateAttorneyCaseTracking,
  updateCaseNextCourtDate,
  updateCaseStatus,
  uploadCaseDocument,
} from '@/app/cases/[id]/actions'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'

type OfferRow = {
  id: string
  case_id: string
  firm_id: string | null
  offered_at: string
  expires_at: string | null
  accepted_at: string | null
  declined_at: string | null
}

type CaseRow = {
  id: string
  state: string
  county: string | null
  citation_number: string | null
  violation_code: string | null
  violation_date?: string | null
  court_date: string | null
  status: string
  notes: string | null
  court_name: string | null
  court_address: string | null
  court_time: string | null
  court_case_number?: string | null
  attorney_update_date?: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type TaskRow = {
  id: string
  case_id: string
  task_type: string
  status: string
  due_at: string | null
  instructions: string | null
}

type DocRow = {
  id: string
  doc_type: string
  filename: string | null
  storage_path: string | null
  created_at: string
  ocr_status: string | null
}

type DocView = DocRow & {
  signedUrl: string | null
  isImage: boolean
}

type OnboardingProfileRow = {
  full_name: string | null
  email: string | null
  phone: string | null
  state: string | null
  office_address: string | null
  zip_code: string | null
  counties: unknown
  coverage_states: unknown
  fee_mode: string | null
  cdl_flat_fee: number | null
  non_cdl_flat_fee: number | null
  agreed_to_terms: boolean | null
  signature_text: string | null
  metadata: Record<string, unknown> | null
}

type CaseFallbackRow = {
  id: string
  state: string
  county: string | null
  citation_number: string | null
  violation_code: string | null
  court_date: string | null
  status: string
  notes: string | null
  created_at: string
  updated_at: string
}

type CaseSecureRow = CaseFallbackRow & {
  court_name?: string | null
  court_address?: string | null
  court_time?: string | null
  violation_date?: string | null
  court_case_number?: string | null
  attorney_update_date?: string | null
  metadata?: Record<string, unknown> | null
  owner_id?: string | null
  driver_id?: string | null
  assigned_attorney_user_id?: string | null
  attorney_firm_id?: string | null
}

type CaseMessageLite = {
  case_id: string
  sender_user_id: string | null
  created_at: string
}

type CaseEventLite = {
  case_id: string
  actor_id: string | null
  created_at: string
}

const CASE_LAST_SEEN_KEY = 'case_last_seen_by_user'

function getOutcome(caseRow: CaseRow) {
  const metadata = caseRow.metadata ?? {}
  const raw = String(
    metadata['disposition_outcome'] ?? metadata['outcome'] ?? metadata['result'] ?? ''
  )
    .trim()
    .toUpperCase()

  if (!raw) return 'OTHER'
  if (raw.includes('GUILTY')) return 'GUILTY'
  if (raw.includes('AMEND')) return 'AMENDED'
  if (raw.includes('DISMISS')) return 'DISMISSED'
  return 'OTHER'
}

function getLastSeenAt(metadata: Record<string, unknown> | null, userId: string) {
  const raw = metadata?.[CASE_LAST_SEEN_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0
  const seenIso = String((raw as Record<string, unknown>)[userId] ?? '').trim()
  if (!seenIso) return 0
  const seenMs = Date.parse(seenIso)
  return Number.isNaN(seenMs) ? 0 : seenMs
}

function normalizeCaseRow(row: Partial<CaseRow> & Pick<CaseRow, 'id'>): CaseRow {
  return {
    id: String(row.id),
    state: String(row.state ?? ''),
    county: row.county ?? null,
    citation_number: row.citation_number ?? null,
    violation_code: row.violation_code ?? null,
    violation_date: row.violation_date ?? null,
    court_date: row.court_date ?? null,
    status: String(row.status ?? 'INTAKE_RECEIVED'),
    notes: row.notes ?? null,
    court_name: row.court_name ?? null,
    court_address: row.court_address ?? null,
    court_time: row.court_time ?? null,
    court_case_number: row.court_case_number ?? null,
    attorney_update_date: row.attorney_update_date ?? null,
    metadata: row.metadata ?? null,
    created_at: String(row.created_at ?? new Date(0).toISOString()),
    updated_at: String(row.updated_at ?? row.created_at ?? new Date(0).toISOString()),
  }
}

async function fetchCasesByColumn(
  supabase: Awaited<ReturnType<typeof createClient>>,
  column: string,
  value: string,
  limit = 300
) {
  const res = await supabase.from('cases').select('*').eq(column, value).order('updated_at', { ascending: false }).limit(limit)
  if (res.error) return [] as CaseSecureRow[]
  return (res.data ?? []) as CaseSecureRow[]
}

async function loadPendingOffers(
  supabase: Awaited<ReturnType<typeof createClient>>,
  firmIds: string[]
): Promise<OfferRow[]> {
  if (!firmIds.length) return []

  const selectVariants = [
    'id, case_id, firm_id, law_firm_org_id, offered_at, expires_at, accepted_at, declined_at',
    'id, case_id, law_firm_org_id, offered_at, expires_at, accepted_at, declined_at',
    'id, case_id, firm_id, offered_at, expires_at, accepted_at, declined_at',
  ]

  for (const selectClause of selectVariants) {
    const query = supabase
      .from('case_assignments')
      .select(selectClause)
      .is('accepted_at', null)
      .is('declined_at', null)
      .order('offered_at', { ascending: false })
      .limit(80)

    const withFirmFilter = selectClause.includes('law_firm_org_id')
      ? query.or(`firm_id.in.(${firmIds.join(',')}),law_firm_org_id.in.(${firmIds.join(',')})`)
      : query.in('firm_id', firmIds)

    const offersRes = await withFirmFilter

    if (offersRes.error) {
      const message = offersRes.error.message
      const isSchemaDrift =
        offersRes.error.code === 'PGRST204' ||
        /column .* does not exist/i.test(message) ||
        /could not find the '.*' column/i.test(message) ||
        /schema cache/i.test(message)

      if (isSchemaDrift) {
        continue
      }

      return []
    }

    return ((offersRes.data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id ?? ''),
      case_id: String(row.case_id ?? ''),
      firm_id:
        typeof row.law_firm_org_id === 'string'
          ? row.law_firm_org_id
          : typeof row.firm_id === 'string'
            ? row.firm_id
            : null,
      offered_at: String(row.offered_at ?? ''),
      expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
      accepted_at: typeof row.accepted_at === 'string' ? row.accepted_at : null,
      declined_at: typeof row.declined_at === 'string' ? row.declined_at : null,
    }))
  }

  return []
}

export default async function AttorneyDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    message?: string
    q?: string
    status?: string
    county?: string
    case?: string
    court_from?: string
    court_to?: string
    view?: string
    page?: string
  }>
}) {
  const params = await searchParams
  const searchQ = String(params?.q ?? '').trim().toLowerCase()
  const statusFilter = String(params?.status ?? '').trim().toUpperCase()
  const countyFilter = String(params?.county ?? '').trim().toLowerCase()
  const courtFromFilter = String(params?.court_from ?? '').trim()
  const courtToFilter = String(params?.court_to ?? '').trim()
  const viewFilter = String(params?.view ?? 'active').trim().toLowerCase()
  const page = Math.max(1, Number.parseInt(String(params?.page ?? '1'), 10) || 1)
  const pageSize = 12
  const selectedCaseIdRaw = String(params?.case ?? '').trim()
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/attorney/login?message=Please%20sign%20in.')
  }

  const profileById = await supabase
    .from('profiles')
    .select('email, full_name, system_role')
    .eq('id', user.id)
    .maybeSingle<{ email: string | null; full_name: string | null; system_role: string | null }>()

  const profileByUserId =
    profileById.data ||
    (
      await supabase
        .from('profiles')
        .select('email, full_name, system_role')
        .eq('user_id', user.id)
        .maybeSingle<{ email: string | null; full_name: string | null; system_role: string | null }>()
    ).data

  const role = normalizePlatformRole(profileByUserId?.system_role)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/dashboard?message=Attorney%20portal%20requires%20an%20attorney%20or%20admin%20role.')
  }

  const onboardingProfileRes =
    isAttorneyRole(role)
      ? await supabase
          .from('attorney_onboarding_profiles')
          .select(
            'full_name, email, phone, state, office_address, zip_code, counties, coverage_states, fee_mode, cdl_flat_fee, non_cdl_flat_fee, agreed_to_terms, signature_text, metadata'
          )
          .eq('user_id', user.id)
          .maybeSingle<OnboardingProfileRow>()
      : { data: null, error: null }
  const onboardingProfile = onboardingProfileRes.data

  if (
    isAttorneyRole(role) &&
    (!onboardingProfile ||
      !onboardingProfile.agreed_to_terms ||
      !String(onboardingProfile.signature_text ?? '').trim())
  ) {
    redirect('/attorney/onboarding?message=Complete%20attorney%20onboarding%20before%20accessing%20the%20portal.')
  }

  const membershipSelects = ['firm_id, law_firm_org_id', 'firm_id', 'law_firm_org_id']
  let firmIds: string[] = []
  for (const selectClause of membershipSelects) {
    const membershipRes = await supabase.from('attorney_firm_memberships').select(selectClause).eq('user_id', user.id).limit(200)
    if (membershipRes.error) {
      const message = membershipRes.error.message
      const isSchemaDrift =
        membershipRes.error.code === 'PGRST204' ||
        /column .* does not exist/i.test(message) ||
        /could not find the '.*' column/i.test(message) ||
        /schema cache/i.test(message)

      if (isSchemaDrift) continue
      break
    }

    firmIds = [
      ...new Set(
        (membershipRes.data ?? [])
          .map((row) => {
            const record = row as { firm_id?: string | null; law_firm_org_id?: string | null }
            return String(record.firm_id ?? record.law_firm_org_id ?? '').trim()
          })
          .filter(Boolean)
      ),
    ]
    break
  }

  const offers = await loadPendingOffers(supabase, firmIds)

  const caseById = new Map<string, CaseRow>()

  const assignedRes = await supabase
    .from('cases')
    .select('*')
    .eq('assigned_attorney_user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(300)

  for (const row of (assignedRes.data ?? []) as CaseRow[]) {
    const normalized = normalizeCaseRow(row)
    caseById.set(normalized.id, normalized)
  }

  if (firmIds.length) {
    const firmCasesRes = await supabase
      .from('cases')
      .select('*')
      .in('attorney_firm_id', firmIds)
      .order('updated_at', { ascending: false })
      .limit(300)

    for (const row of (firmCasesRes.data ?? []) as CaseRow[]) {
      const normalized = normalizeCaseRow(row)
      caseById.set(normalized.id, normalized)
    }
  }

  const ownedCasesRes = await supabase
    .from('cases')
    .select('*')
    .eq('owner_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(300)

  for (const row of (ownedCasesRes.data ?? []) as CaseRow[]) {
    const normalized = normalizeCaseRow(row)
    caseById.set(normalized.id, normalized)
  }

  const driverCasesRes = await supabase
    .from('cases')
    .select('*')
    .eq('driver_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(300)

  for (const row of (driverCasesRes.data ?? []) as CaseRow[]) {
    const normalized = normalizeCaseRow(row)
    caseById.set(normalized.id, normalized)
  }

  // Backward-compatible safety net for environments missing newer case columns.
  const ownerFallbackRes = await supabase
    .from('cases')
    .select('id, state, county, citation_number, violation_code, court_date, status, notes, created_at, updated_at')
    .eq('owner_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(300)

  for (const row of (ownerFallbackRes.data ?? []) as CaseFallbackRow[]) {
    const normalized = normalizeCaseRow(row)
    caseById.set(normalized.id, normalized)
  }

  // Legacy schema fallback ownership columns.
  for (const row of await fetchCasesByColumn(supabase, 'user_id', user.id)) {
    const normalized = normalizeCaseRow(row)
    caseById.set(normalized.id, normalized)
  }
  for (const row of await fetchCasesByColumn(supabase, 'created_by', user.id)) {
    const normalized = normalizeCaseRow(row)
    caseById.set(normalized.id, normalized)
  }

  // Honor explicit ?case=<id> if present, even in mixed-schema/RLS environments.
  if (selectedCaseIdRaw && !caseById.has(selectedCaseIdRaw)) {
    const explicitCaseRes = await supabase
      .from('cases')
      .select('*')
      .eq('id', selectedCaseIdRaw)
      .maybeSingle<CaseRow>()
    if (explicitCaseRes.data) {
      const normalized = normalizeCaseRow(explicitCaseRes.data)
      caseById.set(normalized.id, normalized)
    }
  }

  const allCases = (await hydrateCaseDriverNames(supabase, [...caseById.values()])).sort(
    (a, b) => +new Date(b.updated_at) - +new Date(a.updated_at)
  )
  const caseIds = allCases.map((row) => row.id)
  const lastSeenByCaseId = new Map(allCases.map((row) => [row.id, getLastSeenAt(row.metadata, user.id)]))

  let caseMessageRows: CaseMessageLite[] = []
  if (caseIds.length) {
    const messagesRes = await supabase
      .from('case_messages')
      .select('case_id, sender_user_id, created_at')
      .in('case_id', caseIds)
      .order('created_at', { ascending: false })
      .limit(2000)
    caseMessageRows = (messagesRes.data ?? []) as CaseMessageLite[]
  }

  let caseEventRows: CaseEventLite[] = []
  if (caseIds.length) {
    const eventsRes = await supabase
      .from('case_events')
      .select('case_id, actor_id, created_at')
      .in('case_id', caseIds)
      .order('created_at', { ascending: false })
      .limit(2000)
    caseEventRows = (eventsRes.data ?? []) as CaseEventLite[]
  }

  const unreadByCaseId = new Map<string, number>()
  const bumpUnread = (caseId: string, createdAt: string, actorId: string | null | undefined) => {
    const seenAt = lastSeenByCaseId.get(caseId) ?? 0
    const createdAtMs = Date.parse(createdAt)
    if (Number.isNaN(createdAtMs) || createdAtMs <= seenAt) return
    if (actorId && actorId === user.id) return
    unreadByCaseId.set(caseId, (unreadByCaseId.get(caseId) ?? 0) + 1)
  }

  for (const row of caseMessageRows) {
    bumpUnread(row.case_id, row.created_at, row.sender_user_id)
  }
  for (const row of caseEventRows) {
    bumpUnread(row.case_id, row.created_at, row.actor_id)
  }

  const unreadTotal = [...unreadByCaseId.values()].reduce((sum, value) => sum + value, 0)

  const closedStatuses = new Set(['CLOSED', 'CANCELLED', 'UNABLE_TO_SERVICE'])
  const archivedStatuses = new Set(['CANCELLED', 'UNABLE_TO_SERVICE'])
  const pendingOfferCaseIds = new Set(offers.map((offer) => offer.case_id))
  const now = new Date()
  const closedCases = allCases.filter((c) => closedStatuses.has(String(c.status).toUpperCase()))
  const activeCases = allCases.filter((c) => !closedStatuses.has(String(c.status).toUpperCase()))
  const pastCourtDateCases = activeCases.filter((c) => {
    if (!c.court_date) return false
    const d = new Date(c.court_date)
    if (Number.isNaN(+d)) return false
    return d < now
  })

  const outcomeCounts = {
    GUILTY: 0,
    AMENDED: 0,
    DISMISSED: 0,
    OTHER: 0,
  }

  for (const row of closedCases) {
    outcomeCounts[getOutcome(row)] += 1
  }

  const completionRate = allCases.length ? Math.round((closedCases.length / allCases.length) * 100) : 0

  const tasksRes = await supabase
    .from('case_tasks')
    .select('id, case_id, task_type, status, due_at, instructions')
    .eq('target_role', 'ATTORNEY')
    .in('status', ['OPEN', 'PENDING'])
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(120)

  const tasks = (tasksRes.data ?? []) as TaskRow[]
  const statusOptions = isAttorneyRole(role) ? ATTORNEY_CASE_STATUSES : CASE_STATUSES
  const queueMomentum = Math.max(
    0,
    Math.min(100, Math.round(completionRate * 0.7 + (tasks.length ? 20 : 0) + (offers.length ? 10 : 0)))
  )
  const allStatuses = [...new Set(allCases.map((item) => String(item.status || '').toUpperCase()).filter(Boolean))]
  const allCounties = [...new Set(allCases.map((item) => String(item.county || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
  const viewFilteredCases = allCases.filter((row) => {
    const rowStatus = String(row.status || '').toUpperCase()
    const courtDate = row.court_date ? new Date(row.court_date) : null
    const hasPastCourtDate = !!courtDate && !Number.isNaN(+courtDate) && courtDate < now
    const isPendingAcceptance = pendingOfferCaseIds.has(row.id)
    const isArchived = archivedStatuses.has(rowStatus)
    const isClosed = closedStatuses.has(rowStatus)

    if (viewFilter === 'pending-acceptance') return isPendingAcceptance
    if (viewFilter === 'closed') return isClosed
    if (viewFilter === 'past-court-date') return !isClosed && hasPastCourtDate
    if (viewFilter === 'archived') return isArchived
    return !isClosed
  })
  const filteredCases = viewFilteredCases.filter((row) => {
    const rowStatus = String(row.status || '').toUpperCase()
    const rowCounty = String(row.county || '').trim().toLowerCase()
    const driverName = getCaseDisplayDriverName(row)
    const violationDate = getCaseViolationDate(row) ?? ''
    const courtCaseNumber = getCaseCourtCaseNumber(row) ?? ''
    const haystack = [
      row.id,
      driverName,
      row.state,
      row.county || '',
      row.citation_number || '',
      row.violation_code || '',
      violationDate,
      row.status || '',
      row.court_name || '',
      courtCaseNumber,
    ]
      .join(' ')
      .toLowerCase()

    if (searchQ && !haystack.includes(searchQ)) return false
    if (statusFilter && rowStatus !== statusFilter) return false
    if (countyFilter && rowCounty !== countyFilter) return false
    if (courtFromFilter || courtToFilter) {
      if (!row.court_date) return false
      const rowDate = new Date(row.court_date)
      if (Number.isNaN(+rowDate)) return false

      if (courtFromFilter) {
        const min = new Date(courtFromFilter)
        if (!Number.isNaN(+min) && rowDate < min) return false
      }

      if (courtToFilter) {
        const max = new Date(courtToFilter)
        if (!Number.isNaN(+max) && rowDate > max) return false
      }
    }
    return true
  })
  const totalPages = Math.max(1, Math.ceil(filteredCases.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const startIndex = (safePage - 1) * pageSize
  const pagedCases = filteredCases.slice(startIndex, startIndex + pageSize)

  const selectedCaseId =
    (selectedCaseIdRaw && filteredCases.find((item) => item.id === selectedCaseIdRaw)?.id) ||
    filteredCases[0]?.id ||
    null
  const selectedCase = selectedCaseId ? caseById.get(selectedCaseId) ?? null : null

  let selectedCaseDocs: DocView[] = []
  if (selectedCase) {
    const docsRes = await supabase
      .from('documents')
      .select('id, doc_type, filename, storage_path, created_at, ocr_status')
      .eq('case_id', selectedCase.id)
      .order('created_at', { ascending: false })
      .limit(120)

    selectedCaseDocs = await Promise.all(
      ((docsRes.data ?? []) as DocRow[]).map(async (doc) => {
        if (!doc.storage_path) {
          return {
            ...doc,
            signedUrl: null,
            isImage: false,
          }
        }

        const signed = await supabase.storage.from('case-documents').createSignedUrl(doc.storage_path, 60 * 15)
        const nameForType = `${doc.filename ?? ''} ${doc.storage_path}`.toLowerCase()
        const isImage =
          /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(nameForType) ||
          (doc.doc_type || '').toUpperCase().includes('IMAGE')

        return {
          ...doc,
          signedUrl: signed.data?.signedUrl ?? null,
          isImage,
        }
      })
    )
  }

  const selectedCaseTasks = selectedCase ? tasks.filter((task) => task.case_id === selectedCase.id) : []
  const tableQuery = new URLSearchParams()
  if (searchQ) tableQuery.set('q', searchQ)
  if (statusFilter) tableQuery.set('status', statusFilter)
  if (countyFilter) tableQuery.set('county', countyFilter)
  if (courtFromFilter) tableQuery.set('court_from', courtFromFilter)
  if (courtToFilter) tableQuery.set('court_to', courtToFilter)
  if (viewFilter && viewFilter !== 'active') tableQuery.set('view', viewFilter)
  if (safePage > 1) tableQuery.set('page', String(safePage))
  const selectedCaseQuery = new URLSearchParams(tableQuery.toString())
  if (selectedCase?.id) {
    selectedCaseQuery.set('case', selectedCase.id)
  }
  const selectedCaseReturnTo = `/attorney/dashboard${selectedCaseQuery.toString() ? `?${selectedCaseQuery.toString()}` : ''}`
  const workspaceSummary = getAttorneyWorkspaceSummary(onboardingProfile ?? null)
  const today = new Date()
  const startOfToday = new Date(today)
  startOfToday.setHours(0, 0, 0, 0)
  const nextSevenDays = new Date(startOfToday)
  nextSevenDays.setDate(nextSevenDays.getDate() + 7)
  const upcomingHearings = activeCases
    .filter((caseRow) => {
      if (!caseRow.court_date) return false
      const date = new Date(caseRow.court_date)
      if (Number.isNaN(+date)) return false
      return date >= startOfToday && date <= nextSevenDays
    })
    .sort((a, b) => +new Date(a.court_date ?? 0) - +new Date(b.court_date ?? 0))
  const overdueTasks = tasks.filter((task) => {
    if (!task.due_at) return false
    const date = new Date(task.due_at)
    return !Number.isNaN(+date) && date < today
  })
  const dueThisWeekTasks = tasks.filter((task) => {
    if (!task.due_at) return false
    const date = new Date(task.due_at)
    return !Number.isNaN(+date) && date >= startOfToday && date <= nextSevenDays
  })
  const remindersDueSoon = dueThisWeekTasks.filter((task) => task.task_type === 'ATTORNEY_REMINDER')
  const awaitingDocsCases = activeCases.filter((caseRow) => String(caseRow.status).toUpperCase() === 'CLIENT_DOCS_REQUIRED')
  const newReviewCases = activeCases.filter((caseRow) => String(caseRow.status).toUpperCase() === 'NEEDS_REVIEW')
  const staleMatters = activeCases.filter((caseRow) => {
    const updatedAt = new Date(caseRow.updated_at)
    return !Number.isNaN(+updatedAt) && today.getTime() - updatedAt.getTime() > 1000 * 60 * 60 * 24 * 7
  })
  const conflictMap = new Map<string, number>()
  for (const caseRow of activeCases) {
    if (!caseRow.court_date || !caseRow.court_time) continue
    const key = `${caseRow.court_date}::${caseRow.court_time}`
    conflictMap.set(key, (conflictMap.get(key) ?? 0) + 1)
  }
  const calendarConflicts = [...conflictMap.values()].filter((value) => value > 1).reduce((sum, value) => sum + value - 1, 0)
  const prioritySummary = [
    {
      label: 'Today',
      value: upcomingHearings.filter((caseRow) => String(caseRow.court_date ?? '').slice(0, 10) === startOfToday.toISOString().slice(0, 10)).length,
      hint: 'Hearings on your calendar today',
    },
    {
      label: 'Upcoming Hearings',
      value: upcomingHearings.length,
      hint: 'Next 7 days',
    },
    {
      label: 'Deadlines This Week',
      value: dueThisWeekTasks.length,
      hint: `${summarizeReminderRisk(overdueTasks.length, dueThisWeekTasks.length)} - ${remindersDueSoon.length} reminders`,
    },
    {
      label: 'Unread Communications',
      value: unreadTotal,
      hint: 'Messages and timeline events',
    },
    {
      label: 'Awaiting Documents',
      value: awaitingDocsCases.length,
      hint: 'Client follow-up required',
    },
    {
      label: 'Calendar Conflicts',
      value: calendarConflicts,
      hint: calendarConflicts ? 'Double-booked hearings detected' : 'No current overlaps',
    },
  ]

  return (
    <AttorneyWorkspaceLayout
      active="dashboard"
      title="Attorney Dashboard"
      description="Run your legal workday from one place: review new matters, manage hearings, track deadlines, and keep matter communications attached to the right case."
      actions={
        <>
          <Link href="/attorney/calendar" className="button-link primary">
            Open Calendar
          </Link>
          <Link href="/attorney/reminders#new-reminder" className="button-link secondary">
            New Reminder
          </Link>
          <Link href="/attorney/my-firm" className="button-link secondary">
            My Firm
          </Link>
        </>
      }
      subnav={
        <>
          <Link href="/attorney/dashboard" className={`workspace-subnav-link ${viewFilter === 'active' ? 'active' : ''}`}>
            Active Matters
          </Link>
          <Link
            href="/attorney/dashboard?view=pending-acceptance"
            className={`workspace-subnav-link ${viewFilter === 'pending-acceptance' ? 'active' : ''}`}
          >
            Pending Review
          </Link>
          <Link
            href="/attorney/dashboard?view=past-court-date"
            className={`workspace-subnav-link ${viewFilter === 'past-court-date' ? 'active' : ''}`}
          >
            At Risk
          </Link>
          <Link href="/attorney/dashboard?view=closed" className={`workspace-subnav-link ${viewFilter === 'closed' ? 'active' : ''}`}>
            Closed
          </Link>
          <Link
            href="/attorney/dashboard?view=archived"
            className={`workspace-subnav-link ${viewFilter === 'archived' ? 'active' : ''}`}
          >
            Archived
          </Link>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Signed In</span>
            <strong>{profileByUserId?.email ?? user.email}</strong>
            <span>{role}</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Profile Readiness</span>
            <strong>{workspaceSummary.profileCompletion}% complete</strong>
            <span>{workspaceSummary.countyCount} counties routed</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Inbox Sync</span>
            <strong>{workspaceSummary.emailSyncConnected ? workspaceSummary.emailSyncLabel : 'Manual mode'}</strong>
            <span>{workspaceSummary.emailSyncAddress}</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Calendar Sync</span>
            <strong>{workspaceSummary.calendarSyncConnected ? 'Connected' : 'Not connected'}</strong>
            <span>{workspaceSummary.calendarSyncAddress}</span>
          </article>
        </>
      }
    >
      {params?.message ? <p className="notice">{params.message}</p> : null}

      <section id="today-desk" className="summary-grid">
        {prioritySummary.map((item) => (
          <article key={item.label} className="metric-card">
            <p className="metric-label">{item.label}</p>
            <p className="metric-value">{item.value}</p>
            <p className="workspace-toolbar-copy" style={{ marginTop: 10 }}>
              {item.hint}
            </p>
          </article>
        ))}
      </section>

      <section className="grid-2" style={{ marginTop: 18 }}>
        <article className="card attorney-focus-card">
          <div className="section-heading">
            <div>
              <p className="section-eyebrow">Today</p>
              <h2 className="section-title">Operational focus</h2>
            </div>
            <Link href="/attorney/calendar" className="button-link secondary">
              Calendar view
            </Link>
          </div>
          <div className="attorney-focus-grid">
            <div>
              <h3 className="attorney-mini-heading">Upcoming hearings</h3>
              {!upcomingHearings.length ? (
                <p className="workspace-toolbar-copy">No hearings in the next 7 days.</p>
              ) : (
                <ul className="attorney-feed-list">
                  {upcomingHearings.slice(0, 5).map((caseRow) => (
                    <li key={`hearing-${caseRow.id}`}>
                      <Link href={`/cases/${caseRow.id}?return_to=${encodeURIComponent(selectedCaseReturnTo)}`}>
                        {getCaseDisplayDriverName(caseRow)}
                      </Link>
                      <span>
                        {caseRow.court_date || '-'} · {caseRow.county || '-'} County
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="attorney-mini-heading">Deadline watch</h3>
              {!dueThisWeekTasks.length ? (
                <p className="workspace-toolbar-copy">No attorney tasks due in the next 7 days.</p>
              ) : (
                <ul className="attorney-feed-list">
                  {dueThisWeekTasks.slice(0, 5).map((task) => (
                    <li key={task.id}>
                      <Link href={`/cases/${task.case_id}?return_to=${encodeURIComponent('/attorney/tasks')}`}>{task.instructions || task.task_type}</Link>
                      <span>{task.due_at ? new Date(task.due_at).toLocaleString() : 'No due date'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="attorney-mini-heading">New matters awaiting review</h3>
              <p className="attorney-big-stat">{offers.length + newReviewCases.length}</p>
              <p className="workspace-toolbar-copy">
                {offers.length} pending offers · {newReviewCases.length} marked needs review
              </p>
            </div>
            <div>
              <h3 className="attorney-mini-heading">Matter risk</h3>
              <p className="attorney-big-stat">{pastCourtDateCases.length + overdueTasks.length}</p>
              <p className="workspace-toolbar-copy">
                {pastCourtDateCases.length} past court date · {overdueTasks.length} overdue tasks
              </p>
            </div>
          </div>
        </article>

        <article className="card attorney-focus-card">
          <div className="section-heading">
            <div>
              <p className="section-eyebrow">Readiness</p>
              <h2 className="section-title">Practice routing and visibility</h2>
            </div>
            <Link href="/attorney/my-firm" className="button-link secondary">
              Update profile
            </Link>
          </div>
          <div className="settings-grid">
            <div className="settings-item">
              <span>Coverage</span>
              <strong>
                {workspaceSummary.coverageStateCount} states · {workspaceSummary.countyCount} counties
              </strong>
            </div>
            <div className="settings-item">
              <span>Fee model</span>
              <strong>{workspaceSummary.feeMode === 'BY_COUNTY' ? 'County-specific pricing' : 'Global flat fee'}</strong>
            </div>
            <div className="settings-item">
              <span>Communications</span>
              <strong>{workspaceSummary.emailSyncConnected ? workspaceSummary.emailSyncAddress : 'Manual case-linked logging'}</strong>
            </div>
            <div className="settings-item">
              <span>Scheduling</span>
              <strong>{workspaceSummary.calendarSyncConnected ? workspaceSummary.calendarSyncAddress : 'Calendar sync not connected'}</strong>
            </div>
            <div className="settings-item">
              <span>Awaiting documents</span>
              <strong>{awaitingDocsCases.length} active matters</strong>
            </div>
            <div className="settings-item">
              <span>Stale matters</span>
              <strong>{staleMatters.length} untouched for 7+ days</strong>
            </div>
          </div>
        </article>
      </section>

      <section className="card" style={{ marginTop: 18 }} id="case-queue">
        <div className="section-heading">
          <div>
            <p className="section-eyebrow">Matter Queue</p>
            <h2 className="section-title">Cases requiring review, scheduling, or follow-up</h2>
            <p className="workspace-toolbar-copy">
              Filter quickly, scan docket-critical fields, then open the full matter workspace for communications, documents, and status changes.
            </p>
          </div>
          <div className="page-header-actions" style={{ marginLeft: 'auto' }}>
            <Link href="/attorney/communications" className="button-link secondary">
              Communications
            </Link>
            <Link href="/attorney/tasks" className="button-link secondary">
              Tasks
            </Link>
          </div>
        </div>
        <form method="get" style={{ display: 'grid', gap: 10, marginBottom: 10 }}>
          <input type="hidden" name="view" value={viewFilter} />
          <div className="intake-grid">
            <div>
              <label htmlFor="search-q">Search</label>
              <input
                id="search-q"
                name="q"
                defaultValue={searchQ}
                placeholder="Case ID, citation, county, violation, court"
              />
            </div>
            <div>
              <label htmlFor="search-status">Status Filter</label>
              <select id="search-status" name="status" defaultValue={statusFilter}>
                <option value="">All statuses</option>
                {allStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="search-county">County Filter</label>
              <select id="search-county" name="county" defaultValue={countyFilter}>
                <option value="">All counties</option>
                {allCounties.map((county) => (
                  <option key={county} value={county.toLowerCase()}>
                    {county}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="search-court-from">Court Date From</label>
              <input id="search-court-from" name="court_from" type="date" defaultValue={courtFromFilter} />
            </div>
            <div>
              <label htmlFor="search-court-to">Court Date To</label>
              <input id="search-court-to" name="court_to" type="date" defaultValue={courtToFilter} />
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
              <button type="submit" className="secondary">
                Apply Filters
              </button>
              <Link href={`/attorney/dashboard${viewFilter !== 'active' ? `?view=${encodeURIComponent(viewFilter)}` : ''}`} className="button-link secondary">
                Clear
              </Link>
            </div>
          </div>
        </form>

        {!filteredCases.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No cases match your filters.</p>
        ) : (
	          <div style={{ overflowX: 'auto' }}>
	            <table className="case-table">
	              <thead>
	                <tr>
	                  <th>Open</th>
	                  <th>Driver Name</th>
	                  <th>Violation Date</th>
	                  <th>State</th>
	                  <th>Court Name</th>
	                  <th>Next Court Date</th>
	                  <th>Status</th>
	                  <th>Citation</th>
	                  <th>Court Case #</th>
	                  <th>Attorney Updated</th>
	                  <th>Set Date</th>
	                  <th>Request Payment</th>
	                  <th>Alerts</th>
	                  <th>Updated</th>
	                </tr>
	              </thead>
	              <tbody>
                {pagedCases.map((row) => {
	                  const rowQuery = new URLSearchParams(tableQuery.toString())
	                  rowQuery.set('case', row.id)
	                  const rowReturnTo = `/attorney/dashboard?${rowQuery.toString()}`
	                  const isSelected = selectedCase?.id === row.id
	                  const unreadCount = unreadByCaseId.get(row.id) ?? 0
	                  const driverName = getCaseDisplayDriverName(row)
	                  const violationDate = getCaseViolationDate(row)
	                  const courtCaseNumber = getCaseCourtCaseNumber(row)
	                  const attorneyUpdateDate = getCaseAttorneyUpdateDate(row)
	                  return (
	                    <tr key={row.id} className={isSelected ? 'selected' : undefined}>
	                      <td>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <Link
                            href={`/cases/${row.id}?return_to=${encodeURIComponent(rowReturnTo)}`}
                            className="icon-eye-link"
                            title="Open case"
                            aria-label={`Open case ${row.id}`}
                          >
                            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                              <path
                                d="M12 5C6.5 5 2.1 8.4 1 12c1.1 3.6 5.5 7 11 7s9.9-3.4 11-7c-1.1-3.6-5.5-7-11-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-2.2a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z"
                                fill="currentColor"
                              />
                            </svg>
	                          </Link>
	                        </div>
	                      </td>
	                      <td>
	                        <div className="case-table-primary">
	                          <Link href={rowReturnTo} className="dashboard-table-link">
	                            {driverName}
	                          </Link>
	                          <span className="case-table-secondary">{row.id}</span>
	                        </div>
	                      </td>
	                      <td>{violationDate ?? '-'}</td>
	                      <td>{row.state}</td>
	                      <td>{row.court_name ?? '-'}</td>
	                      <td>{row.court_date ?? '-'}</td>
	                      <td>
	                        <span className="badge">{row.status}</span>
	                      </td>
	                      <td>{row.citation_number ?? '-'}</td>
	                      <td>{courtCaseNumber ?? '-'}</td>
	                      <td>{attorneyUpdateDate ?? '-'}</td>
	                      <td>
	                        <form action={updateCaseNextCourtDate} className="row-inline-form">
	                          <input type="hidden" name="case_id" value={row.id} />
	                          <input type="hidden" name="return_to" value={rowReturnTo} />
	                          <input name="next_court_date" type="date" defaultValue={row.court_date ?? ''} />
                          <button type="submit" className="button-link secondary">
                            Save
                          </button>
                        </form>
                      </td>
                      <td>
                        <form action={requestCasePayment} className="row-inline-form">
                          <input type="hidden" name="case_id" value={row.id} />
                          <input type="hidden" name="source" value="DIRECT_CLIENT" />
                          <input
                            name="amount"
                            type="number"
                            min="0.01"
                            step="0.01"
                            placeholder="Amount"
                            aria-label={`Payment amount for ${row.id}`}
                          />
                          <button type="submit" className="button-link secondary">
                            Request
	                          </button>
	                        </form>
	                      </td>
	                      <td>
	                        <span className={`case-alert-badge${unreadCount ? '' : ' is-zero'}`}>
	                          {unreadCount ? `Bell ${unreadCount}` : 'No new'}
                        </span>
                      </td>
                      <td>{new Date(row.updated_at).toLocaleString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="table-pager">
              <p className="table-pager-info">
                Showing {startIndex + 1}-{Math.min(startIndex + pageSize, filteredCases.length)} of {filteredCases.length}
              </p>
              <div className="table-pager-actions">
                {safePage > 1 ? (
                  <Link
                    href={`/attorney/dashboard?${(() => {
                      const q = new URLSearchParams(tableQuery.toString())
                      q.set('page', String(safePage - 1))
                      return q.toString()
                    })()}`}
                    className="button-link secondary"
                  >
                    Previous
                  </Link>
                ) : null}
                {safePage < totalPages ? (
                  <Link
                    href={`/attorney/dashboard?${(() => {
                      const q = new URLSearchParams(tableQuery.toString())
                      q.set('page', String(safePage + 1))
                      return q.toString()
                    })()}`}
                    className="button-link secondary"
                  >
                    Next
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="grid-2" style={{ marginTop: 16 }}>
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Queue Summary</h2>
          <div style={{ display: 'grid', gap: 8 }}>
            <p style={{ margin: 0 }}>
              <strong>Cases In Progress:</strong> {activeCases.length}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Pending Cases:</strong> {offers.length}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Past Court Dates:</strong> {pastCourtDateCases.length}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Needs Update Tasks:</strong> {tasks.length}
            </p>
          </div>
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Closed Outcomes</h2>
          <div style={{ display: 'grid', gap: 8 }}>
            <p style={{ margin: 0 }}>
              <strong>Closed Guilty:</strong> {outcomeCounts.GUILTY}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Closed Amended:</strong> {outcomeCounts.AMENDED}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Closed Dismissed:</strong> {outcomeCounts.DISMISSED}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Closed Other:</strong> {outcomeCounts.OTHER}
            </p>
          </div>
        </article>
      </section>

      <section className="grid-2" style={{ marginTop: 12 }}>
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Attorney XP</h2>
          <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 14 }}>
            Completion progress from resolved outcomes.
          </p>
          <p style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{completionRate}%</p>
          <div className="xp-track">
            <div className="xp-fill" style={{ width: `${completionRate}%` }} />
          </div>
        </article>
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Queue Momentum</h2>
          <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 14 }}>
            Operational score from active tasks, offers, and closure velocity.
          </p>
          <p style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{queueMomentum}</p>
          <div className="xp-track">
            <div className="xp-fill" style={{ width: `${queueMomentum}%` }} />
          </div>
        </article>
      </section>


      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Pending Offers and Intake Review</h2>
        {!offers.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>
            {newReviewCases.length
              ? `${newReviewCases.length} matters are flagged for review, but no assignment offers are currently pending.`
              : 'No pending offers.'}
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
            {offers.map((offer) => (
              <li key={offer.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  Case ID: <Link href={`/cases/${offer.case_id}`}>{offer.case_id}</Link>
                </p>
	                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
	                  Offered: {new Date(offer.offered_at).toLocaleString()} | Expires:{' '}
	                  {offer.expires_at ? new Date(offer.expires_at).toLocaleString() : '-'}
	                </p>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <form action={acceptCaseOffer}>
                    <input type="hidden" name="assignment_id" value={offer.id} />
                    <button type="submit" className="primary">Accept</button>
                  </form>
                  <form action={declineCaseOffer} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input type="hidden" name="assignment_id" value={offer.id} />
                    <input name="decline_reason" placeholder="Decline reason (optional)" />
                    <button type="submit" className="secondary">Decline</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Selected Matter Workspace</h2>
        {!selectedCase ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>Choose a case from the table above to load full details.</p>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
	            <div style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
	              <p style={{ margin: 0, fontWeight: 700 }}>
	                Case {selectedCase.id} <span className="badge">{selectedCase.status}</span>
	              </p>
	              <p style={{ margin: '6px 0 0 0', color: '#5e6068', fontSize: 14 }}>
	                {getCaseDisplayDriverName(selectedCase)} | {selectedCase.state} | Citation: {selectedCase.citation_number || '-'}
	              </p>
	              <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
	                Violation Date: {getCaseViolationDate(selectedCase) || '-'} | Court Date: {selectedCase.court_date || '-'} | Court:{' '}
	                {selectedCase.court_name || '-'}
	              </p>
	              <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
	                Court Case #: {getCaseCourtCaseNumber(selectedCase) || '-'} | Attorney Updated:{' '}
	                {getCaseAttorneyUpdateDate(selectedCase) || '-'}
	              </p>
	              <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
	                Address: {selectedCase.court_address || '-'} | Time: {selectedCase.court_time || '-'}
	              </p>
              <p style={{ margin: '6px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                Notes: {selectedCase.notes || '-'}
              </p>
              <div style={{ marginTop: 8 }}>
                <Link
                  href={`/cases/${selectedCase.id}?return_to=${encodeURIComponent(selectedCaseReturnTo)}`}
                  className="button-link secondary"
                >
                  Open Full Case Workspace
                </Link>
              </div>
            </div>

	            <div className="grid-2">
	              <article style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
	                <h3 style={{ margin: '0 0 8px 0' }}>Status and Disposition</h3>
                <form action={updateCaseStatus} style={{ display: 'grid', gap: 8 }}>
                  <input type="hidden" name="case_id" value={selectedCase.id} />
                  <input type="hidden" name="return_to" value={selectedCaseReturnTo} />
                  <div>
                    <label htmlFor="attorney-case-status">Case Status</label>
                    <select id="attorney-case-status" name="status" defaultValue={selectedCase.status}>
                      {statusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit" className="secondary">
                    Update Status
                  </button>
                </form>
	                <form action={setCaseDisposition} style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
	                  <input type="hidden" name="case_id" value={selectedCase.id} />
	                  <select name="outcome" defaultValue="DISMISSED">
                    <option value="DISMISSED">Dismissed</option>
                    <option value="AMENDED">Amended</option>
                    <option value="GUILTY">Guilty</option>
                    <option value="OTHER">Other</option>
                  </select>
	                  <button type="submit" className="secondary">
	                    Mark Closed
	                  </button>
	                </form>
	              </article>

	              <article style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
	                <h3 style={{ margin: '0 0 8px 0' }}>Court Case Tracking</h3>
	                <form action={updateAttorneyCaseTracking} className="form-grid">
	                  <input type="hidden" name="case_id" value={selectedCase.id} />
	                  <input type="hidden" name="return_to" value={selectedCaseReturnTo} />
	                  <div>
	                    <label htmlFor="attorney-court-case-number">Court Case Number</label>
	                    <input
	                      id="attorney-court-case-number"
	                      name="court_case_number"
	                      defaultValue={getCaseCourtCaseNumber(selectedCase) ?? ''}
	                      placeholder="Court docket or reference number"
	                    />
	                  </div>
	                  <div>
	                    <label htmlFor="attorney-update-date">Updated Date</label>
	                    <input
	                      id="attorney-update-date"
	                      name="attorney_update_date"
	                      type="date"
	                      defaultValue={String(getCaseAttorneyUpdateDate(selectedCase) ?? '').slice(0, 10)}
	                    />
	                  </div>
	                  <button type="submit" className="secondary">
	                    Save Tracking
	                  </button>
	                </form>
	              </article>

	              <article style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
	                <h3 style={{ margin: '0 0 8px 0' }}>Upload Documents or Pictures</h3>
                <form action={uploadCaseDocument} className="form-grid">
                  <input type="hidden" name="case_id" value={selectedCase.id} />
                  <input type="hidden" name="return_to" value={selectedCaseReturnTo} />
                  <div>
                    <label htmlFor="upload-doc-type">Document Type</label>
                    <input id="upload-doc-type" name="doc_type" defaultValue="ATTORNEY_SUBMISSION" />
                  </div>
                  <div>
                    <label htmlFor="upload-doc-file">Choose File</label>
                    <input id="upload-doc-file" name="document" type="file" required />
                  </div>
                  <button type="submit" className="primary">
                    Upload File
                  </button>
                </form>
              </article>
            </div>

            <article style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
              <h3 style={{ margin: '0 0 8px 0' }}>Request Payment</h3>
              <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                Request payment from CDL Protect operations or your direct client for this case.
              </p>
              <form action={requestCasePayment} className="intake-grid">
                <input type="hidden" name="case_id" value={selectedCase.id} />
                <div>
                  <label htmlFor="payment-source">Payment Source</label>
                  <select id="payment-source" name="source" defaultValue="CDL_PROTECT">
                    <option value="CDL_PROTECT">CDL Protect</option>
                    <option value="DIRECT_CLIENT">Direct Client</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="payment-amount">Amount (USD)</label>
                  <input id="payment-amount" name="amount" type="number" min="0" step="0.01" placeholder="250.00" />
                </div>
                <div className="full">
                  <label htmlFor="payment-notes">Notes</label>
                  <input
                    id="payment-notes"
                    name="notes"
                    placeholder="Include case context, requested method (LawPay/other), and due date."
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
                  <button type="submit" className="primary">
                    Request Payment
                  </button>
                  <Link href="/attorney/onboarding" className="button-link secondary">
                    Connect LawPay
                  </Link>
                </div>
              </form>
            </article>

            <article style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
              <h3 style={{ margin: '0 0 8px 0' }}>Case Documents and Pictures</h3>
              {!selectedCaseDocs.length ? (
                <p style={{ marginBottom: 0, color: '#5e6068' }}>No documents uploaded yet.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
                  {selectedCaseDocs.map((doc) => (
                    <li key={doc.id} style={{ border: '1px solid #efe8d9', borderRadius: 10, padding: 10 }}>
                      <p style={{ margin: 0, fontWeight: 700 }}>
                        {doc.doc_type} | {doc.filename || '<unnamed>'}
                      </p>
                      <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                        Uploaded: {new Date(doc.created_at).toLocaleString()} | OCR: {doc.ocr_status || 'UNKNOWN'}
                      </p>
                      {doc.isImage && doc.signedUrl ? (
                        <div style={{ marginTop: 8 }}>
                          <Image
                            src={doc.signedUrl}
                            alt={doc.filename || 'case image'}
                            width={260}
                            height={180}
                            unoptimized
                            style={{
                              maxWidth: 260,
                              maxHeight: 180,
                              width: '100%',
                              height: 'auto',
                              border: '1px solid #dbd6c8',
                              borderRadius: 8,
                              objectFit: 'contain',
                            }}
                          />
                        </div>
                      ) : null}
                      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {doc.signedUrl ? (
                          <>
                            <a href={doc.signedUrl} target="_blank" rel="noreferrer" className="button-link secondary">
                              Open
                            </a>
                            <a href={doc.signedUrl} download={doc.filename || undefined} className="button-link secondary">
                              Download
                            </a>
                          </>
                        ) : (
                          <span style={{ color: '#5e6068', fontSize: 13 }}>
                            File path unavailable for this record.
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
              <h3 style={{ margin: '0 0 8px 0' }}>Case Tasks</h3>
              {!selectedCaseTasks.length ? (
                <p style={{ marginBottom: 0, color: '#5e6068' }}>No open attorney-targeted tasks for this case.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                  {selectedCaseTasks.map((task) => (
                    <li key={task.id} style={{ border: '1px solid #efe8d9', borderRadius: 8, padding: 8 }}>
                      <p style={{ margin: 0, fontWeight: 700 }}>
                        {task.task_type} <span className="badge">{task.status}</span>
                      </p>
                      <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                        Due: {task.due_at ? new Date(task.due_at).toLocaleString() : 'Not set'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </div>
        )}
      </section>
    </AttorneyWorkspaceLayout>
  )
}
