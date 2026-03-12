import Link from 'next/link'
import { redirect } from 'next/navigation'
import { QueueEyeIcon, SharedCaseQueueTable, type SharedCaseQueueExtraColumn } from '@/app/components/SharedCaseQueueTable'
import {
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
import { CASE_STATUSES } from '@/app/lib/case-status'
import { isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { hydrateCaseDriverNames } from '@/app/lib/server/case-driver-display'
import { getEnabledFeaturesForRole, hasPlatformFeature, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { createClient } from '@/app/lib/supabase/server'
import {
  adminCreateManualAttorneyMatch,
  adminRunAttorneyMatching,
  deleteCaseAdmin,
  importCasesCsv,
  updateCaseAdmin,
} from '../actions'
import { AdminMenu } from '../_components/AdminMenu'

type AdminCaseRow = {
  id: string
  state: string | null
  county: string | null
  citation_number: string | null
  violation_code: string | null
  violation_date?: string | null
  court_date: string | null
  court_case_number?: string | null
  attorney_update_date?: string | null
  status: string
  notes?: string | null
  metadata?: Record<string, unknown> | null
  owner_id?: string | null
  submitter_email?: string | null
  submitter_user_id?: string | null
  agency_id?: string | null
  fleet_id?: string | null
  attorney_firm_id?: string | null
  assigned_attorney_user_id?: string | null
  driver_id?: string | null
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
  court_name?: string | null
  court_address?: string | null
  court_time?: string | null
  updated_at: string
  created_at: string
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

type OutreachRow = {
  id: string
  email: string
  status: string
  outreach_type?: string | null
  quoted_amount_cents?: number | null
  attorney_notes?: string | null
  created_at: string
  responded_at: string | null
}

type AssignmentRow = {
  id: string
  firm_id: string
  offered_at: string
  accepted_at: string | null
  declined_at: string | null
}

type PricingRow = {
  law_firm_org_id: string
  cdl_fee_cents: number
  non_cdl_fee_cents: number
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

type ProfileLookupRow = {
  id?: string | null
  user_id?: string | null
  full_name?: string | null
  email?: string | null
  system_role?: string | null
}

const CASE_SELECT_VARIANTS = [
  'id, state, county, citation_number, violation_code, violation_date, court_date, court_case_number, attorney_update_date, status, notes, metadata, owner_id, submitter_email, submitter_user_id, agency_id, fleet_id, attorney_firm_id, assigned_attorney_user_id, driver_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, court_name, court_address, court_time, updated_at, created_at',
  'id, state, county, citation_number, violation_code, violation_date, court_date, court_case_number, status, notes, metadata, owner_id, submitter_email, submitter_user_id, agency_id, fleet_id, attorney_firm_id, assigned_attorney_user_id, driver_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, updated_at, created_at',
  'id, state, county, citation_number, violation_code, court_date, status, notes, metadata, owner_id, submitter_email, submitter_user_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, updated_at, created_at',
  'id, state, county, citation_number, violation_code, court_date, status, owner_id, submitter_email, submitter_user_id, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, updated_at, created_at',
  'id, state, county, citation_number, violation_code, court_date, status, owner_id, metadata, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, updated_at, created_at',
  'id, state, county, citation_number, violation_code, court_date, status, pricing_available, attorney_fee_cents, platform_fee_cents, total_price_cents, show_paid_pricing_to_fleet_driver, keep_agency_as_primary_contact, primary_contact_type, payment_flow_status, quote_requested_at, quote_received_at, payment_request_sent_at, updated_at, created_at',
  'id, state, county, citation_number, violation_code, violation_date, court_date, court_case_number, attorney_update_date, status, notes, metadata, owner_id, submitter_email, submitter_user_id, agency_id, fleet_id, attorney_firm_id, assigned_attorney_user_id, driver_id, court_name, court_address, court_time, updated_at, created_at',
  'id, state, county, citation_number, violation_code, violation_date, court_date, court_case_number, status, notes, metadata, owner_id, submitter_email, submitter_user_id, agency_id, fleet_id, attorney_firm_id, assigned_attorney_user_id, driver_id, updated_at, created_at',
  'id, state, county, citation_number, violation_code, court_date, status, notes, metadata, owner_id, submitter_email, submitter_user_id, updated_at, created_at',
  'id, state, county, citation_number, violation_code, court_date, status, owner_id, submitter_email, submitter_user_id, updated_at, created_at',
  'id, state, county, citation_number, violation_code, court_date, status, owner_id, metadata, updated_at, created_at',
  'id, state, county, citation_number, violation_code, court_date, status, updated_at, created_at',
]

function isMissingColumnError(message: string) {
  return /column .* does not exist/i.test(message) || /could not find the '.*' column/i.test(message)
}

async function loadProfileLookup(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[]
) {
  const lookup = new Map<string, ProfileLookupRow>()
  if (!ids.length) return lookup

  const upsertRow = (row: ProfileLookupRow) => {
    const id = String(row.id ?? '').trim()
    const userId = String(row.user_id ?? '').trim()
    if (id) lookup.set(id, row)
    if (userId) lookup.set(userId, row)
  }

  const byIdRes = await supabase
    .from('profiles')
    .select('id, user_id, full_name, email, system_role')
    .in('id', ids)

  if (!byIdRes.error) {
    for (const row of (byIdRes.data ?? []) as ProfileLookupRow[]) upsertRow(row)
  } else if (isMissingColumnError(byIdRes.error.message)) {
    const byIdFallback = await supabase.from('profiles').select('id, full_name, email, system_role').in('id', ids)
    if (!byIdFallback.error) {
      for (const row of (byIdFallback.data ?? []) as ProfileLookupRow[]) upsertRow(row)
    }
  }

  const unresolved = ids.filter((id) => !lookup.has(id))
  if (!unresolved.length) return lookup

  const byUserRes = await supabase
    .from('profiles')
    .select('id, user_id, full_name, email, system_role')
    .in('user_id', unresolved)

  if (!byUserRes.error) {
    for (const row of (byUserRes.data ?? []) as ProfileLookupRow[]) upsertRow(row)
  }

  return lookup
}

function getUploaderProfile(caseRow: AdminCaseRow, profileLookup: Map<string, ProfileLookupRow>) {
  const uploaderId = getCaseSubmittedByUserId(caseRow)
  if (!uploaderId) return null
  return profileLookup.get(uploaderId) ?? null
}

function getUploaderAccountLabel(caseRow: AdminCaseRow, profileLookup: Map<string, ProfileLookupRow>) {
  const profile = getUploaderProfile(caseRow, profileLookup)
  const fullName = String(profile?.full_name ?? '').trim()
  const email = String(profile?.email ?? '').trim()
  const fallbackEmail = getCaseSubmitterEmail(caseRow)
  const label = fullName || email || fallbackEmail || getCaseSubmittedByUserId(caseRow) || '-'
  const secondary = label !== email && email ? email : fallbackEmail && fallbackEmail !== label ? fallbackEmail : ''
  return { label, secondary }
}

function getUploaderRoleLabel(caseRow: AdminCaseRow, profileLookup: Map<string, ProfileLookupRow>) {
  const metadataRole = getCaseSubmittedByRole(caseRow)
  if (metadataRole) return metadataRole

  const profile = getUploaderProfile(caseRow, profileLookup)
  const role = String(profile?.system_role ?? '').trim().toUpperCase()
  return role || '-'
}

async function loadCasesWithFallback(supabase: Awaited<ReturnType<typeof createClient>>) {
  let lastError = ''

  for (const selectClause of CASE_SELECT_VARIANTS) {
    const response = await supabase
      .from('cases')
      .select(selectClause)
      .order('updated_at', { ascending: false })
      .limit(500)

    if (!response.error) {
      return { data: (response.data ?? []) as unknown as AdminCaseRow[], error: null as string | null }
    }

    lastError = response.error.message
    if (!isMissingColumnError(response.error.message)) {
      break
    }
  }

  return { data: [] as AdminCaseRow[], error: lastError || 'Could not load cases.' }
}

function parseDateInput(value: string | null | undefined) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(+parsed)) return null
  parsed.setHours(0, 0, 0, 0)
  return parsed
}

function toDateFieldValue(value: string | null | undefined) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)

  const parsed = new Date(value)
  if (Number.isNaN(+parsed)) return ''
  const yyyy = parsed.getFullYear()
  const mm = String(parsed.getMonth() + 1).padStart(2, '0')
  const dd = String(parsed.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function getCaseSourceLabel(caseRow: AdminCaseRow) {
  const metadata = caseRow.metadata ?? {}
  const sourceRaw = String(metadata['case_source'] ?? metadata['source'] ?? metadata['intake_source'] ?? '')
    .trim()
    .toUpperCase()
  const submittedByRole = String(metadata['submitted_by_role'] ?? '').trim().toUpperCase()
  const submittedVia = String(metadata['submitted_via'] ?? '').trim().toUpperCase()

  if (sourceRaw.includes('ATTORNEY') || submittedByRole === 'ATTORNEY' || submittedVia.includes('ATTORNEY')) {
    return 'Attorney Uploaded (External)'
  }

  if (!sourceRaw) {
    return 'CDL Protect Intake'
  }

  return sourceRaw
    .split('_')
    .map((chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase())
    .join(' ')
}

function formatUsd(cents: number | null | undefined) {
  const value = Number(cents ?? 0)
  if (!Number.isFinite(value)) return '-'
  return `$${(value / 100).toFixed(2)}`
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

export default async function AdminCasesPage({
  searchParams,
}: {
  searchParams: Promise<{
    message?: string
    q?: string
    status?: string
    court_from?: string
    court_to?: string
    case?: string
  }>
}) {
  const params = await searchParams
  const qInput = String(params?.q ?? '').trim()
  const q = qInput.toLowerCase()
  const statusFilter = String(params?.status ?? '').trim().toUpperCase()
  const courtFrom = String(params?.court_from ?? '').trim()
  const courtTo = String(params?.court_to ?? '').trim()
  const selectedCaseIdRaw = String(params?.case ?? '').trim()

  const fromDate = parseDateInput(courtFrom)
  const toDate = parseDateInput(courtTo)
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/admin/login?message=Please%20sign%20in.')
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
  if (!isStaffRole(role)) {
    redirect('/dashboard?message=Admin%20dashboard%20requires%20ADMIN%2C%20OPS%2C%20or%20AGENT%20role.')
  }
  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
  const autoMatchingEnabled = hasPlatformFeature(enabledFeatures, 'attorney_matching_auto')
  const manualMatchingEnabled = hasPlatformFeature(enabledFeatures, 'attorney_matching_manual')

  const loadResult = await loadCasesWithFallback(supabase)
  const allCases = await hydrateCaseDriverNames(supabase, loadResult.data)

  const filteredCases = allCases.filter((caseRow) => {
    const rowStatus = String(caseRow.status || '').toUpperCase()
    const rowCourtDate = parseDateInput(caseRow.court_date)

    if (statusFilter && rowStatus !== statusFilter) {
      return false
    }

    if (fromDate && (!rowCourtDate || rowCourtDate < fromDate)) {
      return false
    }

    if (toDate && (!rowCourtDate || rowCourtDate > toDate)) {
      return false
    }

    if (q) {
      const displayName = getCaseDisplayDriverName(caseRow)
      const metadataText = caseRow.metadata ? JSON.stringify(caseRow.metadata).toLowerCase() : ''
      const haystack = [
        caseRow.id,
        caseRow.citation_number ?? '',
        caseRow.violation_code ?? '',
        getCaseViolationDate(caseRow) ?? '',
        getCaseCourtCaseNumber(caseRow) ?? '',
        caseRow.state ?? '',
        caseRow.county ?? '',
        caseRow.status ?? '',
        caseRow.court_name ?? '',
        caseRow.notes ?? '',
        displayName,
        metadataText,
      ]
        .join(' ')
        .toLowerCase()

      if (!haystack.includes(q)) {
        return false
      }
    }

    return true
  })

  const statusOptions = [
    ...new Set(allCases.map((caseRow) => String(caseRow.status || '').toUpperCase()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b))

  const selectedCaseId =
    (selectedCaseIdRaw && filteredCases.find((caseRow) => caseRow.id === selectedCaseIdRaw)?.id) ||
    filteredCases[0]?.id ||
    null
  const selectedCase = selectedCaseId ? filteredCases.find((caseRow) => caseRow.id === selectedCaseId) ?? null : null
  const uploaderIds = [
    ...new Set(
      filteredCases
        .map((caseRow) => getCaseSubmittedByUserId(caseRow))
        .filter((value): value is string => Boolean(value))
    ),
  ]
  const profileLookup = await loadProfileLookup(supabase, uploaderIds)

  if (selectedCase) {
    try {
      await syncAttorneyMatchingCoverageForJurisdiction({
        state: selectedCase.state,
        county: selectedCase.county,
      })
    } catch (error) {
      console.error('Admin attorney coverage sync failed:', error)
    }
  }

  const [attorneyFirmsRes, selectedCaseQuotesRes, selectedCaseOutreachRes, selectedCaseAssignmentsRes, pricingRes, selectedCasePaymentRequestsRes] =
    await Promise.all([
      supabase.from('attorney_firms').select('id, company_name').eq('is_active', true).order('company_name', { ascending: true }),
      selectedCase
        ? supabase
            .from('case_quotes')
            .select('id, law_firm_org_id, attorney_fee_cents, platform_fee_cents, total_cents, status, quote_source, created_at')
            .eq('case_id', selectedCase.id)
            .order('created_at', { ascending: false })
            .limit(6)
        : Promise.resolve({ data: [], error: null }),
      selectedCase
        ? supabase
            .from('attorney_outreach')
            .select('id, email, status, outreach_type, quoted_amount_cents, attorney_notes, created_at, responded_at')
            .eq('case_id', selectedCase.id)
            .order('created_at', { ascending: false })
            .limit(12)
        : Promise.resolve({ data: [], error: null }),
      selectedCase
        ? supabase
            .from('case_assignments')
            .select('id, firm_id, offered_at, accepted_at, declined_at')
            .eq('case_id', selectedCase.id)
            .order('offered_at', { ascending: false })
            .limit(8)
        : Promise.resolve({ data: [], error: null }),
      selectedCase?.state && selectedCase?.county
        ? supabase
            .from('attorney_pricing')
            .select('law_firm_org_id, cdl_fee_cents, non_cdl_fee_cents')
            .eq('state', String(selectedCase.state).toUpperCase())
            .eq('county', String(selectedCase.county).toUpperCase())
            .eq('is_active', true)
            .order('cdl_fee_cents', { ascending: true })
            .limit(12)
        : Promise.resolve({ data: [], error: null }),
      selectedCase
        ? supabase
            .from('payment_requests')
            .select('id, quote_id, amount_cents, status, source_type, provider, request_email, due_at, sent_at, paid_at, created_at')
            .eq('case_id', selectedCase.id)
            .order('created_at', { ascending: false })
            .limit(8)
        : Promise.resolve({ data: [], error: null }),
    ])
  const attorneyFirms = (attorneyFirmsRes.data ?? []) as AttorneyFirmOption[]
  const selectedCaseQuotes = (selectedCaseQuotesRes.data ?? []) as CaseQuoteRow[]
  const selectedCaseOutreach = (selectedCaseOutreachRes.data ?? []) as OutreachRow[]
  const selectedCaseAssignments = (selectedCaseAssignmentsRes.data ?? []) as AssignmentRow[]
  const pricingRows = (pricingRes.data ?? []) as PricingRow[]
  const selectedCasePaymentRequests = (selectedCasePaymentRequestsRes.data ?? []) as PaymentRequestRow[]
  const firmNameById = new Map(attorneyFirms.map((firm) => [firm.id, firm.company_name]))
  const currentQuote =
    selectedCaseQuotes.find((quote) => ['OPEN', 'AWAITING_PAYMENT'].includes(String(quote.status).toUpperCase())) ?? null
  const latestQuote = currentQuote ?? selectedCaseQuotes[0] ?? null
  const latestPaymentRequest = selectedCasePaymentRequests[0] ?? null
  const pendingOutreachCount = selectedCaseOutreach.filter((row) => String(row.status).toUpperCase() === 'PENDING').length
  const acceptedOutreachCount = selectedCaseOutreach.filter((row) => String(row.status).toUpperCase() === 'ACCEPTED').length
  const quotedOutreachCount = selectedCaseOutreach.filter((row) => String(row.status).toUpperCase() === 'QUOTED').length
  const declinedOutreachCount = selectedCaseOutreach.filter((row) => String(row.status).toUpperCase() === 'DECLINED').length
  const pendingOfferCount = selectedCaseAssignments.filter((row) => !row.accepted_at && !row.declined_at).length
  const acceptedOfferCount = selectedCaseAssignments.filter((row) => !!row.accepted_at).length
  const pricingByFirmId = new Map(pricingRows.map((row) => [row.law_firm_org_id, row]))
  const selectedUploaderAccount = selectedCase ? getUploaderAccountLabel(selectedCase, profileLookup) : null
  const selectedUploaderRole = selectedCase ? getUploaderRoleLabel(selectedCase, profileLookup) : null
  const selectedSubmitterName = selectedCase ? getCaseSubmitterName(selectedCase) : null
  const selectedSubmitterEmail = selectedCase ? getCaseSubmitterEmail(selectedCase) : null
  const selectedSubmitterPhone = selectedCase ? getCaseSubmitterPhone(selectedCase) : null
  const selectedPaymentFlowLabel = selectedCase ? formatFlowLabel(selectedCase.payment_flow_status) : 'Not started'
  const selectedBranchLabel = selectedCase
    ? selectedCase.pricing_available
      ? 'Direct priced flow'
      : selectedCase.quote_requested_at
        ? 'Quote requested flow'
        : 'Matching pending'
    : '-'

  const closedStatuses = new Set(['CLOSED', 'CANCELLED', 'UNABLE_TO_SERVICE'])
  const closedCount = filteredCases.filter((caseRow) => closedStatuses.has(String(caseRow.status).toUpperCase())).length
  const completionRate = filteredCases.length ? Math.round((closedCount / filteredCases.length) * 100) : 0
  const queueHealth = Math.max(0, Math.min(100, Math.round(completionRate * 0.8 + (filteredCases.length ? 20 : 0))))

  const stickyQuery = new URLSearchParams()
  if (qInput) stickyQuery.set('q', qInput)
  if (statusFilter) stickyQuery.set('status', statusFilter)
  if (courtFrom) stickyQuery.set('court_from', courtFrom)
  if (courtTo) stickyQuery.set('court_to', courtTo)
  const selectedCaseQuery = new URLSearchParams(stickyQuery.toString())
  if (selectedCase?.id) {
    selectedCaseQuery.set('case', selectedCase.id)
  }
  const selectedCaseRedirectPath = `/admin/cases${selectedCase?.id ? `?${selectedCaseQuery.toString()}` : ''}`
  const queueExtraColumns: SharedCaseQueueExtraColumn<AdminCaseRow>[] = [
    {
      key: 'uploaded_by',
      header: 'Uploaded By',
      render: (caseRow) => {
        const account = getUploaderAccountLabel(caseRow, profileLookup)
        return (
          <div className="case-table-primary">
            <span>{account.label}</span>
            {account.secondary ? <span className="case-table-secondary">{account.secondary}</span> : null}
          </div>
        )
      },
    },
    {
      key: 'uploaded_role',
      header: 'Uploaded Role',
      render: (caseRow) => getUploaderRoleLabel(caseRow, profileLookup),
    },
    {
      key: 'source',
      header: 'Source',
      render: (caseRow) => getCaseSourceLabel(caseRow),
    },
    {
      key: 'updated',
      header: 'Updated',
      render: (caseRow) => new Date(caseRow.updated_at).toLocaleString(),
    },
  ]

  return (
    <div style={{ padding: '18px 0 28px' }}>
      <section
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 34 }}>Cases</h1>
          <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 14 }}>
            Search by ticket number, name, violation, county, status, and more.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link href="/admin/dashboard" className="button-link secondary">
            Back to Overview
          </Link>
          <Link href="/logout" className="button-link secondary">
            Sign Out
          </Link>
        </div>
      </section>

      <AdminMenu active="cases" />

      {params?.message ? (
        <section style={{ marginTop: 12 }}>
          <p className="notice">{params.message}</p>
        </section>
      ) : null}

      <section
        style={{
          marginTop: 14,
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        }}
      >
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Filtered Cases</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{filteredCases.length}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Closed In Filter</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{closedCount}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Completion XP</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{completionRate}%</p>
          <div className="xp-track">
            <div className="xp-fill" style={{ width: `${completionRate}%` }} />
          </div>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Queue Health</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{queueHealth}</p>
          <div className="xp-track">
            <div className="xp-fill" style={{ width: `${queueHealth}%` }} />
          </div>
        </article>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Filters and Search</h2>
        <form method="get" className="form-grid">
          <div className="intake-grid">
            <div>
              <label htmlFor="cases-search">Search</label>
              <input
                id="cases-search"
                name="q"
                defaultValue={qInput}
                placeholder="Ticket #, name, violation, county, court, status"
              />
            </div>
            <div>
              <label htmlFor="cases-status">Status</label>
              <select id="cases-status" name="status" defaultValue={statusFilter}>
                <option value="">All statuses</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="cases-court-from">Court Date From</label>
              <input id="cases-court-from" name="court_from" type="date" defaultValue={courtFrom} />
            </div>
            <div>
              <label htmlFor="cases-court-to">Court Date To</label>
              <input id="cases-court-to" name="court_to" type="date" defaultValue={courtTo} />
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
              <button type="submit" className="secondary">
                Apply
              </button>
              <Link href="/admin/cases" className="button-link secondary">
                Clear
              </Link>
            </div>
          </div>
        </form>
      </section>

	      <section className="card" style={{ marginTop: 14 }}>
	        <h2 style={{ margin: '0 0 8px 0' }}>Bulk Case Upload (CSV)</h2>
	        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
	          Recognized headers include <code>driver_name</code>, <code>violation_date</code>, <code>court_name</code>,{' '}
	          <code>court_date</code>, <code>court_case_number</code>, <code>state</code>, and related variants.
	        </p>
	        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
	          <a href="/api/templates/cases-csv" className="button-link secondary">
	            Download CSV Template
	          </a>
	        </div>
	        <form action={importCasesCsv} className="form-grid">
          <input type="hidden" name="redirect_to" value="/admin/cases" />
          <div>
            <label htmlFor="admin-cases-csv-file">Cases CSV file</label>
            <input id="admin-cases-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
          </div>
          <button type="submit" className="secondary">
            Import Cases
          </button>
        </form>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Case Table</h2>
        {loadResult.error ? (
          <p className="error">Error loading cases: {loadResult.error}</p>
        ) : !filteredCases.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No cases match the selected filters.</p>
        ) : (
          <SharedCaseQueueTable
            rows={filteredCases}
            selectedCaseId={selectedCase?.id ?? null}
            getRowHref={(caseRow) => {
              const rowQuery = new URLSearchParams(stickyQuery.toString())
              rowQuery.set('case', caseRow.id)
              return `/admin/cases?${rowQuery.toString()}`
            }}
            getRowSubtitle={(caseRow) => caseRow.id}
            renderOpenCell={(caseRow) => {
              const rowQuery = new URLSearchParams(stickyQuery.toString())
              rowQuery.set('case', caseRow.id)
              return (
                <Link
                  href={`/admin/cases?${rowQuery.toString()}`}
                  className="icon-eye-link"
                  title="Open case"
                  aria-label={`Open case ${caseRow.id}`}
                >
                  <QueueEyeIcon />
                </Link>
              )
            }}
            extraColumns={queueExtraColumns}
          />
        )}
      </section>

	      <section className="card" style={{ marginTop: 14 }}>
	        <h2 style={{ margin: '0 0 8px 0' }}>Attorney Matching</h2>
	        {!selectedCase ? (
	          <p style={{ marginBottom: 0, color: '#5e6068' }}>Select a case from the table to run automatic or manual attorney matching.</p>
          ) : !autoMatchingEnabled && !manualMatchingEnabled ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>Attorney matching controls are disabled for your current admin role.</p>
	        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
	            <div
	              style={{
	                display: 'grid',
	                gap: 12,
	                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
	              }}
	            >
	              <article className="card" style={{ margin: 0 }}>
	                <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Current Status</p>
	                <p style={{ margin: '8px 0 0 0', fontSize: 24, fontWeight: 800 }}>{selectedCase.status}</p>
	              </article>
	              <article className="card" style={{ margin: 0 }}>
	                <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Workflow Branch</p>
	                <p style={{ margin: '8px 0 0 0', fontSize: 24, fontWeight: 800 }}>{selectedBranchLabel}</p>
	              </article>
	              <article className="card" style={{ margin: 0 }}>
	                <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Open Quote</p>
	                <p style={{ margin: '8px 0 0 0', fontSize: 24, fontWeight: 800 }}>
	                  {latestQuote ? formatUsd(latestQuote.total_cents) : 'None'}
	                </p>
	              </article>
	              <article className="card" style={{ margin: 0 }}>
	                <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Pending Outreach</p>
	                <p style={{ margin: '8px 0 0 0', fontSize: 24, fontWeight: 800 }}>{pendingOutreachCount}</p>
	              </article>
	              <article className="card" style={{ margin: 0 }}>
	                <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Pending Offers</p>
	                <p style={{ margin: '8px 0 0 0', fontSize: 24, fontWeight: 800 }}>{pendingOfferCount}</p>
	              </article>
	              <article className="card" style={{ margin: 0 }}>
	                <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Payment Flow</p>
	                <p style={{ margin: '8px 0 0 0', fontSize: 20, fontWeight: 800 }}>{selectedPaymentFlowLabel}</p>
	                <div style={{ marginTop: 8, color: '#5e6068', fontSize: 13 }}>
	                  {latestPaymentRequest ? `Latest request: ${formatFlowLabel(latestPaymentRequest.status)}` : 'No payment request yet'}
	                </div>
	              </article>
	            </div>

            <div className="grid-2">
	              <article className="card" style={{ margin: 0 }}>
	                <h3 style={{ marginTop: 0 }}>Automatic Matching</h3>
                <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                  Re-run pricing lookup and local outreach using the case’s current state, county, and court details.
                </p>
	                {autoMatchingEnabled ? (
	                  <form action={adminRunAttorneyMatching} className="form-grid">
	                    <input type="hidden" name="redirect_to" value={selectedCaseRedirectPath} />
	                    <input type="hidden" name="case_id" value={selectedCase.id} />
	                    <button type="submit" className="primary">
	                      Run Automatic Matching
	                    </button>
	                  </form>
	                ) : (
                    <p className="notice" style={{ marginBottom: 0 }}>Automatic attorney matching is disabled for your role.</p>
                  )}
	                <div style={{ marginTop: 12, color: '#5e6068', fontSize: 13 }}>
	                  <div>Matched Firm: {selectedCase.attorney_firm_id ? firmNameById.get(selectedCase.attorney_firm_id) || selectedCase.attorney_firm_id : 'Unassigned'}</div>
	                  <div>Accepted Outreach: {acceptedOutreachCount}</div>
	                  <div>Quoted Outreach: {quotedOutreachCount}</div>
	                  <div>Declined Outreach: {declinedOutreachCount}</div>
	                  <div>Accepted Offers: {acceptedOfferCount}</div>
	                </div>
	              </article>

              <article className="card" style={{ margin: 0 }}>
                <h3 style={{ marginTop: 0 }}>Manual Match</h3>
                <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                  Select a firm and fee to create or reuse the live quote immediately. Pending outreach and offers are superseded.
                </p>
	                {manualMatchingEnabled ? (
	                <form action={adminCreateManualAttorneyMatch} className="form-grid">
                  <input type="hidden" name="redirect_to" value={selectedCaseRedirectPath} />
                  <input type="hidden" name="case_id" value={selectedCase.id} />
                  <div>
                    <label htmlFor="admin-manual-match-firm">Attorney Firm</label>
                    <select
                      id="admin-manual-match-firm"
                      name="firm_id"
                      defaultValue={selectedCase.attorney_firm_id ?? ''}
                      required
                    >
                      <option value="" disabled>
                        Select a firm
                      </option>
                      {attorneyFirms.map((firm) => {
                        const pricing = pricingByFirmId.get(firm.id)
                        const pricingLabel = pricing ? ` | CDL ${formatUsd(pricing.cdl_fee_cents)}` : ''
                        return (
                          <option key={firm.id} value={firm.id}>
                            {firm.company_name}
                            {pricingLabel}
                          </option>
                        )
                      })}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="admin-manual-match-fee">Attorney Fee (USD)</label>
                    <input
                      id="admin-manual-match-fee"
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
                  <button type="submit" className="primary">
                    Create Manual Match
                  </button>
	                </form>
                  ) : (
                    <p className="notice" style={{ marginBottom: 0 }}>Manual attorney matching is disabled for your role.</p>
                  )}
	              </article>
	            </div>

	            <div className="grid-2">
	              <article className="card" style={{ margin: 0 }}>
	                <h3 style={{ marginTop: 0 }}>Workflow State</h3>
	                <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
	                  <p style={{ margin: 0 }}>
	                    <strong>Pricing Available Initially:</strong> {selectedCase.pricing_available ? 'Yes' : 'No'}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Attorney Fee:</strong> {formatUsd(selectedCase.attorney_fee_cents)}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Platform Fee:</strong> {formatUsd(selectedCase.platform_fee_cents)}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Total Price:</strong> {formatUsd(selectedCase.total_price_cents)}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Primary Contact:</strong> {String(selectedCase.primary_contact_type ?? '').trim() || 'SUBMITTER'}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Show Pricing to Fleet/Driver:</strong> {selectedCase.show_paid_pricing_to_fleet_driver ? 'Yes' : 'No'}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Keep Agency Primary Contact:</strong> {selectedCase.keep_agency_as_primary_contact ? 'Yes' : 'No'}
	                  </p>
	                </div>
	              </article>
	              <article className="card" style={{ margin: 0 }}>
	                <h3 style={{ marginTop: 0 }}>Timeline</h3>
	                <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
	                  <p style={{ margin: 0 }}>
	                    <strong>Quote Requested:</strong> {formatDateTime(selectedCase.quote_requested_at)}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Quote Received:</strong> {formatDateTime(selectedCase.quote_received_at)}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Payment Request Sent:</strong> {formatDateTime(selectedCase.payment_request_sent_at)}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Latest Payment Request:</strong> {latestPaymentRequest ? formatFlowLabel(latestPaymentRequest.status) : 'None'}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Payment Amount:</strong> {latestPaymentRequest ? formatUsd(latestPaymentRequest.amount_cents) : '-'}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Requested To:</strong> {latestPaymentRequest?.request_email ?? '-'}
	                  </p>
	                  <p style={{ margin: 0 }}>
	                    <strong>Paid At:</strong> {formatDateTime(latestPaymentRequest?.paid_at)}
	                  </p>
	                </div>
	              </article>
	            </div>

	            <div className="table-shell">
	              <table className="data-table">
	                <thead>
	                  <tr>
	                    <th>Type</th>
	                    <th>Summary</th>
	                    <th>Status</th>
	                    <th>Response / Amount</th>
	                    <th>Created</th>
	                  </tr>
	                </thead>
	                <tbody>
	                  {latestQuote ? (
	                    <tr>
	                      <td>Quote</td>
	                      <td>
	                        {firmNameById.get(latestQuote.law_firm_org_id) || latestQuote.law_firm_org_id} | Fee{' '}
	                        {formatUsd(latestQuote.attorney_fee_cents)} + Platform {formatUsd(latestQuote.platform_fee_cents)}
	                      </td>
	                      <td>{latestQuote.status}</td>
	                      <td>{String(latestQuote.quote_source ?? '').trim() || '-'}</td>
	                      <td>{new Date(latestQuote.created_at).toLocaleString()}</td>
	                    </tr>
	                  ) : null}
	                  {selectedCaseOutreach.slice(0, 6).map((row) => (
	                    <tr key={row.id}>
	                      <td>Outreach</td>
	                      <td>
	                        {row.email}
	                        {row.outreach_type ? ` | ${row.outreach_type}` : ''}
	                      </td>
	                      <td>{row.status}</td>
	                      <td>
	                        {row.responded_at ? formatDateTime(row.responded_at) : row.quoted_amount_cents ? formatUsd(row.quoted_amount_cents) : '-'}
	                      </td>
	                      <td>{new Date(row.created_at).toLocaleString()}</td>
	                    </tr>
	                  ))}
	                  {selectedCasePaymentRequests.slice(0, 4).map((row) => (
	                    <tr key={row.id}>
	                      <td>Payment</td>
	                      <td>
	                        {row.request_email ?? '-'}
	                        {row.source_type ? ` | ${row.source_type}` : ''}
	                      </td>
	                      <td>{row.status}</td>
	                      <td>{formatUsd(row.amount_cents)}</td>
	                      <td>{new Date(row.created_at).toLocaleString()}</td>
	                    </tr>
	                  ))}
	                  {selectedCaseAssignments.slice(0, 3).map((row) => (
	                    <tr key={row.id}>
	                      <td>Offer</td>
	                      <td>{firmNameById.get(row.firm_id) || row.firm_id}</td>
	                      <td>{row.accepted_at ? 'ACCEPTED' : row.declined_at ? 'DECLINED' : 'PENDING'}</td>
	                      <td>{row.accepted_at ? formatDateTime(row.accepted_at) : row.declined_at ? formatDateTime(row.declined_at) : '-'}</td>
	                      <td>{new Date(row.offered_at).toLocaleString()}</td>
	                    </tr>
	                  ))}
	                  {!latestQuote && !selectedCaseOutreach.length && !selectedCaseAssignments.length && !selectedCasePaymentRequests.length ? (
	                    <tr>
	                      <td colSpan={5} style={{ color: '#5e6068' }}>
	                        No matching activity recorded yet for this case.
	                      </td>
	                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Submitter and Uploader</h2>
        {!selectedCase ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>Select a case from the table to review intake contact and uploader details.</p>
        ) : (
          <div className="grid-2">
            <article className="card" style={{ margin: 0 }}>
              <h3 style={{ marginTop: 0 }}>Submitter Contact</h3>
              <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
                <p style={{ margin: 0 }}>
                  <strong>Name:</strong> {selectedSubmitterName ?? '-'}
                </p>
                <p style={{ margin: 0 }}>
                  <strong>Email:</strong> {selectedSubmitterEmail ?? '-'}
                </p>
                <p style={{ margin: 0 }}>
                  <strong>Phone:</strong> {selectedSubmitterPhone ?? '-'}
                </p>
              </div>
            </article>
            <article className="card" style={{ margin: 0 }}>
              <h3 style={{ marginTop: 0 }}>Uploaded By</h3>
              <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
                <p style={{ margin: 0 }}>
                  <strong>Account:</strong> {selectedUploaderAccount?.label ?? '-'}
                </p>
                {selectedUploaderAccount?.secondary ? (
                  <p style={{ margin: 0 }}>
                    <strong>Account Email:</strong> {selectedUploaderAccount.secondary}
                  </p>
                ) : null}
                <p style={{ margin: 0 }}>
                  <strong>Role:</strong> {selectedUploaderRole ?? '-'}
                </p>
                <p style={{ margin: 0 }}>
                  <strong>User ID:</strong> {getCaseSubmittedByUserId(selectedCase) ?? '-'}
                </p>
              </div>
            </article>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Edit Case</h2>
        {!selectedCase ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>Select a case from the table to edit details.</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0, color: '#5e6068', fontSize: 14 }}>
              Editing case <strong>{selectedCase.id}</strong> | Source:{' '}
              <strong>{getCaseSourceLabel(selectedCase)}</strong>
            </p>

            <form action={updateCaseAdmin} className="form-grid">
              <input type="hidden" name="redirect_to" value={selectedCaseRedirectPath} />
              <input type="hidden" name="case_id" value={selectedCase.id} />
              <div className="intake-grid">
                <div>
                  <label htmlFor="admin-case-state">State</label>
                  <input id="admin-case-state" name="state" defaultValue={selectedCase.state ?? ''} />
                </div>
                <div>
                  <label htmlFor="admin-case-county">County</label>
                  <input id="admin-case-county" name="county" defaultValue={selectedCase.county ?? ''} />
                </div>
                <div>
                  <label htmlFor="admin-case-citation">Citation Number</label>
                  <input
                    id="admin-case-citation"
                    name="citation_number"
                    defaultValue={selectedCase.citation_number ?? ''}
                  />
                </div>
	                <div>
	                  <label htmlFor="admin-case-violation">Violation</label>
	                  <input
	                    id="admin-case-violation"
	                    name="violation_code"
	                    defaultValue={selectedCase.violation_code ?? ''}
	                  />
	                </div>
	                <div>
	                  <label htmlFor="admin-case-violation-date">Violation Date</label>
	                  <input
	                    id="admin-case-violation-date"
	                    name="violation_date"
	                    type="date"
	                    defaultValue={toDateFieldValue(getCaseViolationDate(selectedCase))}
	                  />
	                </div>
	                <div>
	                  <label htmlFor="admin-case-court-date">Court Date</label>
	                  <input
	                    id="admin-case-court-date"
                    name="court_date"
                    type="date"
                    defaultValue={toDateFieldValue(selectedCase.court_date)}
                  />
                </div>
                <div>
                  <label htmlFor="admin-case-status">Status</label>
                  <select id="admin-case-status" name="status" defaultValue={selectedCase.status}>
                    {CASE_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </div>
	                <div>
	                  <label htmlFor="admin-case-court-name">Court Name</label>
	                  <input id="admin-case-court-name" name="court_name" defaultValue={selectedCase.court_name ?? ''} />
	                </div>
	                <div>
	                  <label htmlFor="admin-case-court-case-number">Court Case Number</label>
	                  <input
	                    id="admin-case-court-case-number"
	                    name="court_case_number"
	                    defaultValue={getCaseCourtCaseNumber(selectedCase) ?? ''}
	                  />
	                </div>
	                <div>
	                  <label htmlFor="admin-case-court-address">Court Address</label>
	                  <input
	                    id="admin-case-court-address"
	                    name="court_address"
                    defaultValue={selectedCase.court_address ?? ''}
                  />
                </div>
	                <div>
	                  <label htmlFor="admin-case-court-time">Court Time</label>
	                  <input id="admin-case-court-time" name="court_time" defaultValue={selectedCase.court_time ?? ''} />
	                </div>
	                <div>
	                  <label htmlFor="admin-case-attorney-update-date">Attorney Updated Date</label>
	                  <input
	                    id="admin-case-attorney-update-date"
	                    name="attorney_update_date"
	                    type="date"
	                    defaultValue={toDateFieldValue(selectedCase.attorney_update_date)}
	                  />
	                </div>
                <div>
                  <label htmlFor="admin-case-agency-id">Agency ID</label>
                  <input id="admin-case-agency-id" name="agency_id" defaultValue={selectedCase.agency_id ?? ''} />
                </div>
                <div>
                  <label htmlFor="admin-case-fleet-id">Fleet ID</label>
                  <input id="admin-case-fleet-id" name="fleet_id" defaultValue={selectedCase.fleet_id ?? ''} />
                </div>
                <div>
                  <label htmlFor="admin-case-firm-id">Attorney Firm ID</label>
                  <input
                    id="admin-case-firm-id"
                    name="attorney_firm_id"
                    defaultValue={selectedCase.attorney_firm_id ?? ''}
                  />
                </div>
                <div>
                  <label htmlFor="admin-case-assigned-attorney-id">Assigned Attorney User ID</label>
                  <input
                    id="admin-case-assigned-attorney-id"
                    name="assigned_attorney_user_id"
                    defaultValue={selectedCase.assigned_attorney_user_id ?? ''}
                  />
                </div>
                <div>
                  <label htmlFor="admin-case-driver-id">Driver User ID</label>
                  <input id="admin-case-driver-id" name="driver_id" defaultValue={selectedCase.driver_id ?? ''} />
                </div>
              </div>

              <div>
                <label htmlFor="admin-case-notes">Notes</label>
                <textarea id="admin-case-notes" name="notes" rows={3} defaultValue={selectedCase.notes ?? ''} />
              </div>

              <button type="submit" className="primary">
                Save Case
              </button>
            </form>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link href={`/cases/${selectedCase.id}`} className="button-link secondary">
                Open Full Case
              </Link>
              <form action={deleteCaseAdmin}>
                <input type="hidden" name="redirect_to" value={selectedCaseRedirectPath} />
                <input type="hidden" name="case_id" value={selectedCase.id} />
                <button type="submit" className="secondary">
                  Delete Case
                </button>
              </form>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
