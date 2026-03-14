import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AgencyWorkspaceLayout } from '@/app/components/AgencyWorkspaceLayout'
import { QueueEyeIcon, SharedCaseQueueTable, type SharedCaseQueueExtraColumn } from '@/app/components/SharedCaseQueueTable'
import {
  getCaseCourtCaseNumber,
  getCaseDisplayDriverName,
  getCaseViolationDate,
} from '@/app/lib/cases/display'
import { CASE_STATUSES } from '@/app/lib/case-status'
import { getAccessibleAgencyOptions } from '@/app/lib/server/agency-access'
import { claimRoleInvitesSafe } from '@/app/lib/server/claim-invites'
import { hydrateCaseDriverNames } from '@/app/lib/server/case-driver-display'
import { getAccessibleFleetOptions, getFleetRowsByIds } from '@/app/lib/server/fleet-access'
import { getEnabledFeaturesForRole, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { getServerAuthUser } from '@/app/lib/supabase/auth-user'
import { createClient } from '@/app/lib/supabase/server'
import {
  acceptCaseOffer,
  assignCaseToFleet,
  bulkAssignCasesToFleet,
  createFleet,
  declineCaseOffer,
  importScopedCasesCsv,
  offerCaseToAttorney,
  sendRoleInvite,
} from './actions'
import { updateCaseStatus, uploadCaseDocument } from '@/app/cases/[id]/actions'
import {
  isAgencyRole,
  isAttorneyRole,
  isStaffRole,
  normalizePlatformRole,
  roleCanCreateFleet,
  roleHasFleetWorkspace,
} from '@/app/lib/roles'

type CaseRow = {
  id: string
  state: string | null
  county: string | null
  court_name: string | null
  court_date: string | null
  citation_number: string | null
  violation_code: string | null
  violation_date?: string | null
  court_case_number?: string | null
  fleet_id: string | null
  driver_id?: string | null
  metadata?: Record<string, unknown> | null
  status: string
  created_at: string
  updated_at: string
}

type OfferRow = {
  id: string
  case_id: string
  firm_id: string
  offered_at: string
  expires_at: string
  accepted_at: string | null
  declined_at: string | null
}

type TaskRow = {
  id: string
  case_id: string
  task_type: string
  status: string
  due_at: string | null
  created_at: string
}

type MessageRow = {
  id: string
  case_id: string
  sender_user_id: string | null
}

type DocRow = {
  id: string
  doc_type: string
  filename: string | null
  storage_path: string | null
  created_at: string
}

type DocView = DocRow & {
  signedUrl: string | null
}

type FleetOption = {
  id: string
  company_name: string
}

type SelfInviteRow = {
  id: string
  target_role: string
  fleet_id: string | null
  accepted_at: string | null
  expires_at: string | null
  created_at: string
}

const ROLE_CAPABILITIES: Record<string, string[]> = {
  AGENCY: [
    'Create and manage fleet accounts.',
    'Monitor all agency/fleet cases.',
    'Upload cases/documents and request attorney quotes/updates.',
  ],
  FLEET: [
    'Upload citations and supporting documents.',
    'Track only your fleet-scoped cases.',
    'Request attorney updates from case pages.',
  ],
  DRIVER: [
    'Track only cases linked to your signed-in email.',
    'Upload supporting documents and respond to case requests.',
    'Review status, court dates, and attorney updates for your own matters.',
  ],
  ATTORNEY: [
    'Accept or decline case offers.',
    'Request client documents and signatures.',
    'Manage pending, active, and closed dispositions.',
  ],
  ADMIN: [
    'Monitor all cases and assignment pipelines.',
    'Invite agencies, fleets, attorneys, and drivers.',
    'Offer cases to attorney firms and handle exceptions.',
  ],
  OPS: [
    'Monitor all cases and assignment pipelines.',
    'Invite agencies, fleets, attorneys, and drivers.',
    'Offer cases to attorney firms and handle exceptions.',
  ],
  AGENT: [
    'Monitor all cases and assignment pipelines.',
    'Invite agencies, fleets, attorneys, and drivers.',
    'Offer cases to attorney firms and handle exceptions.',
  ],
}

function toTimestamp(value: string | null) {
  if (!value) return Number.NEGATIVE_INFINITY
  const date = new Date(value)
  if (Number.isNaN(+date)) return Number.NEGATIVE_INFINITY
  return +date
}

function getCaseSortComparator(sortKey: string) {
  switch (sortKey) {
    case 'updated_asc':
      return (a: CaseRow, b: CaseRow) => toTimestamp(a.updated_at) - toTimestamp(b.updated_at)
    case 'court_asc':
      return (a: CaseRow, b: CaseRow) => toTimestamp(a.court_date) - toTimestamp(b.court_date)
    case 'court_desc':
      return (a: CaseRow, b: CaseRow) => toTimestamp(b.court_date) - toTimestamp(a.court_date)
    case 'created_desc':
      return (a: CaseRow, b: CaseRow) => toTimestamp(b.created_at) - toTimestamp(a.created_at)
    case 'updated_desc':
    default:
      return (a: CaseRow, b: CaseRow) => toTimestamp(b.updated_at) - toTimestamp(a.updated_at)
  }
}

function buildDashboardHref(
  baseParams: URLSearchParams,
  updates: Record<string, string | null | undefined>,
  hash?: string
) {
  const next = new URLSearchParams(baseParams.toString())
  for (const [key, value] of Object.entries(updates)) {
    if (!value) {
      next.delete(key)
      continue
    }
    next.set(key, value)
  }

  const query = next.toString()
  return `/dashboard${query ? `?${query}` : ''}${hash ?? ''}`
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    message?: string
    q?: string
    status?: string
    county?: string
    fleet?: string
    quick?: string
    case?: string
    sort?: string
    tab?: string
  }>
}) {
  const params = await searchParams
  const searchQ = String(params?.q ?? '').trim().toLowerCase()
  const statusFilter = String(params?.status ?? '').trim().toUpperCase()
  const countyFilter = String(params?.county ?? '').trim().toLowerCase()
  const fleetFilter = String(params?.fleet ?? '').trim()
  const quickFilter = String(params?.quick ?? '').trim().toLowerCase()
  const selectedCaseIdRaw = String(params?.case ?? '').trim()
  const sortKey = String(params?.sort ?? 'updated_desc').trim()
  const workspaceTab = String(params?.tab ?? '').trim().toLowerCase()
  const isCasesView = workspaceTab === 'cases'
  const supabase = await createClient()
  const user = await getServerAuthUser(supabase)

  if (!user) {
    redirect('/login?message=Your%20session%20expired.%20Please%20sign%20in%20again.')
  }

  await claimRoleInvitesSafe()

  const { data: profileById } = await supabase
    .from('profiles')
    .select('email, full_name, system_role')
    .eq('id', user.id)
    .maybeSingle<{ email: string | null; full_name: string | null; system_role: string | null }>()

  const profileByUserId =
    profileById ||
    (
      await supabase
        .from('profiles')
        .select('email, full_name, system_role')
        .eq('user_id', user.id)
        .maybeSingle<{ email: string | null; full_name: string | null; system_role: string | null }>()
    ).data

  const role = normalizePlatformRole(profileByUserId?.system_role)
  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
  if (isAttorneyRole(role)) {
    redirect('/attorney/dashboard')
  }
  const hasFleetWorkspace = roleHasFleetWorkspace(role)
  const canCreateFleet = roleCanCreateFleet(role)
  const fleetOptions = hasFleetWorkspace ? ((await getAccessibleFleetOptions(supabase, user.id)) as FleetOption[]) : []
  const agencyOptions = isAgencyRole(role) ? await getAccessibleAgencyOptions(supabase, user.id) : []
  const selfOpenInvitesRes =
    role === 'FLEET' || isAgencyRole(role)
      ? await supabase
          .from('platform_invites')
          .select('id, target_role, fleet_id, accepted_at, expires_at, created_at')
          .is('accepted_at', null)
          .order('created_at', { ascending: false })
          .limit(8)
      : { data: [] as SelfInviteRow[], error: null }
  const selfOpenInvites = ((selfOpenInvitesRes.data ?? []) as SelfInviteRow[]).filter((invite) => !invite.accepted_at)
  const pendingInviteFleetIds = [...new Set(selfOpenInvites.map((invite) => invite.fleet_id).filter(Boolean) as string[])]
  const pendingInviteFleets = await getFleetRowsByIds(supabase, pendingInviteFleetIds, { includeArchived: true })
  const pendingInviteFleetNameById = new Map(pendingInviteFleets.map((fleet) => [fleet.id, fleet.company_name]))

  const roleCapabilities = ROLE_CAPABILITIES[role] ?? [
    'Submit ticket intake and monitor status updates.',
    'Upload case documents and run OCR extraction.',
    'Use case timeline and workflow actions.',
  ]

  const { data: cases, error } = await supabase
    .from('cases')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(240)

  const { data: myOffers } = await supabase
    .from('case_assignments')
    .select('id, case_id, firm_id, offered_at, expires_at, accepted_at, declined_at')
    .is('accepted_at', null)
    .is('declined_at', null)
    .order('offered_at', { ascending: false })
    .limit(30)

  const { data: openTasks } = await supabase
    .from('case_tasks')
    .select('id, case_id, task_type, status, due_at, created_at')
    .in('status', ['OPEN', 'PENDING'])
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(40)
  const { data: latestMessages } = await supabase
    .from('case_messages')
    .select('id, case_id, sender_user_id')
    .order('created_at', { ascending: false })
    .limit(500)

  const { data: attorneyFirms } = await supabase
    .from('attorney_firms')
    .select('id, company_name')
    .eq('is_active', true)
    .order('company_name', { ascending: true })
    .limit(50)

  const offerRows = (myOffers ?? []) as OfferRow[]
  const taskRows = (openTasks ?? []) as TaskRow[]
  const messageRows = (latestMessages ?? []) as MessageRow[]
  const caseRows = (await hydrateCaseDriverNames(supabase, ((cases ?? []) as CaseRow[]))).sort(getCaseSortComparator(sortKey))

  const taskCountByCase = new Map<string, number>()
  for (const task of taskRows) {
    taskCountByCase.set(task.case_id, (taskCountByCase.get(task.case_id) ?? 0) + 1)
  }
  const unreadMessageCountByCase = new Map<string, number>()
  for (const msg of messageRows) {
    if (msg.sender_user_id === user.id) continue
    unreadMessageCountByCase.set(msg.case_id, (unreadMessageCountByCase.get(msg.case_id) ?? 0) + 1)
  }
  const actionRequiredCount = taskRows.length + messageRows.filter((m) => m.sender_user_id !== user.id).length
  const fleetNameById = new Map(fleetOptions.map((fleet) => [fleet.id, fleet.company_name]))

  const statusOptions = [...new Set(caseRows.map((item) => String(item.status || '').toUpperCase()).filter(Boolean))]
  const countyOptions = [...new Set(caseRows.map((item) => String(item.county || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
  const queueFleetOptions = [...fleetOptions].sort((a, b) => a.company_name.localeCompare(b.company_name))
  const canReassignCases = isStaffRole(role) || isAgencyRole(role) || role === 'FLEET'
  const canImportCases = isStaffRole(role) || isAgencyRole(role) || role === 'FLEET'
  const canInviteAgency = isStaffRole(role) || isAgencyRole(role)
  const effectiveFleetFilter = hasFleetWorkspace ? fleetFilter : ''
  const openFleet = effectiveFleetFilter ? queueFleetOptions.find((fleet) => fleet.id === effectiveFleetFilter) ?? null : null

  const closedStatuses = new Set(['CLOSED', 'CANCELLED', 'UNABLE_TO_SERVICE'])
  const pendingCaseIds = new Set(offerRows.map((offer) => offer.case_id))
  const taskCaseIds = new Set(taskRows.map((task) => task.case_id))
  const attentionCaseIds = new Set([
    ...taskRows.map((task) => task.case_id),
    ...messageRows.filter((msg) => msg.sender_user_id !== user.id).map((msg) => msg.case_id),
  ])
  const pastCourtCaseIds = new Set(
    caseRows
      .filter((item) => {
        if (!item.court_date) return false
        const courtDate = new Date(item.court_date)
        if (Number.isNaN(+courtDate)) return false
        return courtDate < new Date() && !closedStatuses.has(String(item.status).toUpperCase())
      })
      .map((item) => item.id)
  )

  const filteredCases = caseRows.filter((item) => {
    const itemStatus = String(item.status || '').toUpperCase()
    const itemCounty = String(item.county || '').trim().toLowerCase()
    const itemFleetId = String(item.fleet_id ?? '').trim()
    const driverName = getCaseDisplayDriverName(item)
    const violationDate = getCaseViolationDate(item) ?? ''
    const courtCaseNumber = getCaseCourtCaseNumber(item) ?? ''
    const haystack = [
      item.id,
      driverName,
      item.state || '',
      item.county || '',
      item.court_name || '',
      item.citation_number || '',
      courtCaseNumber,
      item.violation_code || '',
      violationDate,
      item.status || '',
    ]
      .join(' ')
      .toLowerCase()

    if (searchQ && !haystack.includes(searchQ)) return false
    if (statusFilter && statusFilter !== itemStatus) return false
    if (countyFilter && countyFilter !== itemCounty) return false
    if (effectiveFleetFilter && effectiveFleetFilter !== itemFleetId) return false
    if (quickFilter === 'in_progress' && closedStatuses.has(itemStatus)) return false
    if (quickFilter === 'pending' && !pendingCaseIds.has(item.id)) return false
    if (quickFilter === 'past_court' && !pastCourtCaseIds.has(item.id)) return false
    if (quickFilter === 'tasks' && !taskCaseIds.has(item.id)) return false
    if (quickFilter === 'attention' && !attentionCaseIds.has(item.id)) return false
    return true
  })

  const selectedCaseId =
    (selectedCaseIdRaw && filteredCases.find((item) => item.id === selectedCaseIdRaw)?.id) ||
    filteredCases[0]?.id ||
    null
  const selectedCase = selectedCaseId ? caseRows.find((item) => item.id === selectedCaseId) ?? null : null
  const selectedCaseTasks = taskRows.filter((task) => task.case_id === selectedCaseId)

  let selectedDocs: DocView[] = []
  if (selectedCase) {
    const docsRes = await supabase
      .from('documents')
      .select('id, doc_type, filename, storage_path, created_at')
      .eq('case_id', selectedCase.id)
      .order('created_at', { ascending: false })
      .limit(40)

    selectedDocs = await Promise.all(
      ((docsRes.data ?? []) as DocRow[]).map(async (doc) => {
        if (!doc.storage_path) {
          return { ...doc, signedUrl: null }
        }
        const signed = await supabase.storage.from('case-documents').createSignedUrl(doc.storage_path, 60 * 15)
        return { ...doc, signedUrl: signed.data?.signedUrl ?? null }
      })
    )
  }

  const inProgressCount = caseRows.filter((item) => !closedStatuses.has(String(item.status).toUpperCase())).length
  const pendingCasesCount = offerRows.length
  const openTasksCount = taskRows.length
  const pastCourtDatesCount = pastCourtCaseIds.size
  const closedCount = caseRows.length - inProgressCount
  const completionRate = caseRows.length ? Math.round((closedCount / caseRows.length) * 100) : 0
  const workflowMomentum = Math.max(
    0,
    Math.min(100, Math.round(completionRate * 0.7 + (openTasksCount ? 20 : 0) + (pendingCasesCount ? 10 : 0)))
  )

  const stickyQuery = new URLSearchParams()
  if (searchQ) stickyQuery.set('q', searchQ)
  if (statusFilter) stickyQuery.set('status', statusFilter)
  if (countyFilter) stickyQuery.set('county', countyFilter)
  if (effectiveFleetFilter) stickyQuery.set('fleet', effectiveFleetFilter)
  if (quickFilter) stickyQuery.set('quick', quickFilter)
  if (sortKey) stickyQuery.set('sort', sortKey)
  if (isCasesView) stickyQuery.set('tab', 'cases')
  const filterQuery = new URLSearchParams(stickyQuery.toString())
  filterQuery.delete('case')
  const dashboardTitle = isCasesView ? 'My Cases' : 'Dashboard'
  const dashboardDescription = isCasesView
    ? hasFleetWorkspace
      ? 'Direct queue access for case review, fleet reassignment, attorney follow-up, and document collection.'
      : 'Direct queue access for your own cases, documents, status changes, and attorney follow-up.'
    : hasFleetWorkspace
      ? 'Monitor case volume, fleet routing, attorney activity, and workspace actions from one operations dashboard.'
      : 'Track your own case updates, upload documents, and stay current on court and attorney activity from one dashboard.'
  const queueExtraColumns: SharedCaseQueueExtraColumn<CaseRow>[] = []
  if (hasFleetWorkspace) {
    queueExtraColumns.push({
      key: 'fleet',
      header: 'Fleet',
      render: (item) =>
        item.fleet_id ? (
          <Link
            href={buildDashboardHref(filterQuery, { fleet: item.fleet_id, case: item.id }, '#case-queue')}
            className="dashboard-table-link"
          >
            {fleetNameById.get(item.fleet_id) ?? item.fleet_id.slice(0, 8)}
          </Link>
        ) : (
          <span style={{ color: '#5e6068' }}>Unassigned</span>
        ),
    })
  }
  queueExtraColumns.push(
    {
      key: 'attention',
      header: 'Actions Required',
      render: (item) => {
        const rowQuery = new URLSearchParams(stickyQuery.toString())
        rowQuery.set('case', item.id)
        const tasks = taskCountByCase.get(item.id) ?? 0
        const messages = unreadMessageCountByCase.get(item.id) ?? 0
        const total = tasks + messages
        if (!total) return <span style={{ color: '#5e6068' }}>0</span>
        return (
          <Link
            href={`/cases/${item.id}?return_to=${encodeURIComponent(`/dashboard?${rowQuery.toString()}`)}`}
            className="dashboard-attention-pill"
            aria-label={`${total} actions required`}
          >
            {messages ? `${messages} msg` : ''}
            {messages && tasks ? ' + ' : ''}
            {tasks ? `${tasks} task` : ''}
          </Link>
        )
      },
    },
    {
      key: 'updated',
      header: 'Updated',
      render: (item) => new Date(item.updated_at).toLocaleString(),
    }
  )

  return (
    <AgencyWorkspaceLayout
      role={role}
      enabledFeatures={enabledFeatures}
      active={isCasesView ? 'cases' : 'overview'}
      title={dashboardTitle}
      description={dashboardDescription}
      actions={
        <>
          <Link href="/intake" className="button-link primary">
            + Add Traffic Ticket
          </Link>
          {hasFleetWorkspace ? (
            <Link href="/my-fleets" className="button-link secondary">
              My Fleets
            </Link>
          ) : null}
          {canCreateFleet ? (
            <Link href="/my-fleets#create-fleet" className="button-link secondary">
              Create Fleet
            </Link>
          ) : null}
        </>
      }
    >
      <div className="workspace-stack">
        <section className="workspace-toolbar card">
          <div className="workspace-toolbar-summary">
            <p className="workspace-toolbar-copy">
              Signed in as <strong>{profileByUserId?.email ?? user.email}</strong> · {role}
            </p>
            <p className="workspace-toolbar-copy">
              {profileByUserId?.full_name || 'User'} can review queue health, route cases by fleet, and follow up with attorneys from one
              workspace.
            </p>
          </div>
          <div className="workspace-toolbar-actions">
            <Link
              href={buildDashboardHref(filterQuery, { quick: 'attention', case: null }, '#case-queue')}
              className="dashboard-inline-alert"
              aria-label={`${actionRequiredCount} actions or unread messages`}
            >
              <span className="dashboard-inline-alert-count">{actionRequiredCount}</span>
              <span>Needs attention</span>
            </Link>
          </div>
        </section>

        {params?.message ? <p className="notice">{params.message}</p> : null}

        <nav className="workspace-subnav" aria-label="Dashboard sections">
          {!isCasesView ? (
            <>
              <a href="#overview-metrics" className="workspace-subnav-link">
                Overview
              </a>
              <a href="#fleet-access" className="workspace-subnav-link">
                Fleet Access
              </a>
              {canImportCases ? (
                <a href="#case-import" className="workspace-subnav-link">
                  Bulk Import
                </a>
              ) : null}
            </>
          ) : null}
          <a href="#case-queue" className="workspace-subnav-link">
            Case Queue
          </a>
          <a href="#selected-case" className="workspace-subnav-link">
            Selected Case
          </a>
          {(isAgencyRole(role) || isStaffRole(role)) && !isCasesView ? (
            <a href="#create-fleet" className="workspace-subnav-link">
              Create Fleet
            </a>
          ) : null}
        </nav>

        {!isCasesView ? (
          <>
            <section className="summary-grid" id="overview-metrics">
              <Link
                href={buildDashboardHref(filterQuery, { quick: 'in_progress', case: null }, '#case-queue')}
                className="card dashboard-metric-link"
              >
                <p className="metric-label">Cases In Progress</p>
                <p className="metric-value">{inProgressCount}</p>
                <div className="dashboard-metric-footer">
                  <span>Open filtered queue</span>
                  <span aria-hidden="true">{'->'}</span>
                </div>
              </Link>
              <Link
                href={buildDashboardHref(filterQuery, { quick: 'pending', case: null }, '#case-queue')}
                className="card dashboard-metric-link"
              >
                <p className="metric-label">Pending Cases</p>
                <p className="metric-value">{pendingCasesCount}</p>
                <div className="dashboard-metric-footer">
                  <span>Open filtered queue</span>
                  <span aria-hidden="true">{'->'}</span>
                </div>
              </Link>
              <Link
                href={buildDashboardHref(filterQuery, { quick: 'past_court', case: null }, '#case-queue')}
                className="card dashboard-metric-link"
              >
                <p className="metric-label">Past Court Dates</p>
                <p className="metric-value">{pastCourtDatesCount}</p>
                <div className="dashboard-metric-footer">
                  <span>Open filtered queue</span>
                  <span aria-hidden="true">{'->'}</span>
                </div>
              </Link>
              <Link
                href={buildDashboardHref(filterQuery, { quick: 'tasks', case: null }, '#case-queue')}
                className="card dashboard-metric-link"
              >
                <p className="metric-label">Open Workflow Tasks</p>
                <p className="metric-value">{openTasksCount}</p>
                <div className="dashboard-metric-footer">
                  <span>Open filtered queue</span>
                  <span aria-hidden="true">{'->'}</span>
                </div>
              </Link>
            </section>

            <section className="grid-2">
              <article className="card">
                <div className="section-heading">
                  <div>
                    <p className="section-eyebrow">Performance</p>
                    <h2 className="section-title">Case Resolution XP</h2>
                  </div>
                </div>
                <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 14 }}>
                  Completion progress from total queue outcomes.
                </p>
                <p style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{completionRate}%</p>
                <div className="xp-track">
                  <div className="xp-fill" style={{ width: `${completionRate}%` }} />
                </div>
              </article>
              <article className="card">
                <div className="section-heading">
                  <div>
                    <p className="section-eyebrow">Health</p>
                    <h2 className="section-title">Workflow Momentum</h2>
                  </div>
                </div>
                <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 14 }}>
                  Combined health score across open tasks and active case movement.
                </p>
                <p style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{workflowMomentum}</p>
                <div className="xp-track">
                  <div className="xp-fill" style={{ width: `${workflowMomentum}%` }} />
                </div>
              </article>
            </section>

            <section className="card">
              <div className="section-heading">
                <div>
                  <p className="section-eyebrow">Capabilities</p>
                  <h2 className="section-title">Role-specific actions</h2>
                </div>
              </div>
              <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                {profileByUserId?.full_name || 'User'} workspace actions for {role}.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, color: '#5e6068', display: 'grid', gap: 6 }}>
                {roleCapabilities.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>

            {(isAgencyRole(role) || role === 'FLEET') && (
              <section className="card" id="fleet-access">
                <div className="section-heading">
                  <div>
                    <p className="section-eyebrow">Fleet Access</p>
                    <h2 className="section-title">{role === 'FLEET' ? 'Your Fleet Access' : 'Manage by Fleet'}</h2>
                  </div>
                </div>
                <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                  {role === 'FLEET'
                    ? 'Refresh-safe fleet membership routing: every linked fleet opens directly into its case queue.'
                    : 'Open a fleet queue directly, review agency-added cases, or jump into intake with a fleet preselected.'}
                </p>
                {!fleetOptions.length ? (
                  <p style={{ marginBottom: 0, color: '#5e6068' }}>
                    {role === 'FLEET'
                      ? 'No fleet access is linked to this account yet. Once an agency invite is sent, refresh this dashboard to claim it.'
                      : 'No fleets are linked to this workspace yet. Create a fleet from My Fleets to start routing cases.'}
                  </p>
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {fleetOptions.map((fleet) => (
                      <Link
                        key={fleet.id}
                        href={buildDashboardHref(filterQuery, { fleet: fleet.id, case: null }, '#case-queue')}
                        className="dashboard-attention-pill"
                      >
                        {fleet.company_name}
                      </Link>
                    ))}
                  </div>
                )}
                {selfOpenInvites.length ? (
                  <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>Pending Access Invites</p>
                    {selfOpenInvites.map((invite) => (
                      <Link
                        key={invite.id}
                        href={
                          invite.fleet_id
                            ? buildDashboardHref(filterQuery, { fleet: invite.fleet_id, case: null }, '#case-queue')
                            : '/dashboard'
                        }
                        className="dashboard-attention-pill"
                      >
                        {invite.target_role} invite{' '}
                        {invite.fleet_id ? `for ${pendingInviteFleetNameById.get(invite.fleet_id) ?? 'assigned fleet'}` : ''}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </section>
            )}

            {openFleet && isAgencyRole(role) ? (
              <section className="card">
                <div className="section-heading">
                  <div>
                    <p className="section-eyebrow">Fleet Actions</p>
                    <h2 className="section-title">Open Fleet Actions</h2>
                  </div>
                </div>
                <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                  {openFleet.company_name} is currently open in the queue. Use these shortcuts to manage the fleet directly.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Link href={`/intake?fleet=${encodeURIComponent(openFleet.id)}`} className="button-link secondary">
                    Add New Case
                  </Link>
                  <Link
                    href={`/my-fleets?invite_fleet=${encodeURIComponent(openFleet.id)}&invite_role=FLEET#invite-driver`}
                    className="button-link secondary"
                  >
                    Invite Fleet
                  </Link>
                  <Link href={`/my-fleets?edit=${encodeURIComponent(openFleet.id)}#edit-fleet`} className="button-link primary">
                    Edit Fleet Info
                  </Link>
                </div>
              </section>
            ) : null}

            {canImportCases ? (
              <section className="card" id="case-import">
                <div className="section-heading">
                  <div>
                    <p className="section-eyebrow">Import</p>
                    <h2 className="section-title">Bulk Case Import</h2>
                  </div>
                </div>
                <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                  Download the CSV template first, then upload existing case inventory into your agency or fleet workspace.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <a href="/api/templates/cases-csv" className="button-link secondary">
                    Download CSV Template
                  </a>
                  <Link href="/my-fleets#fleet-directory" className="button-link secondary">
                    Open Fleet Directory
                  </Link>
                </div>
                <form action={importScopedCasesCsv} className="form-grid">
                  <input type="hidden" name="return_to" value="/dashboard#case-import" />
                  <div className="intake-grid">
                    <div>
                      <label htmlFor="scoped-cases-csv-file">Cases CSV File</label>
                      <input id="scoped-cases-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'end' }}>
                      <button type="submit" className="secondary">
                        Upload Existing Cases
                      </button>
                    </div>
                  </div>
                  <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>
                    Required minimum fields: <code>state</code> and <code>citation_number</code>. Recommended fields include
                    <code> driver_name</code>, <code>violation_date</code>, <code>court_name</code>, <code>court_date</code>, and
                    <code> court_case_number</code>.
                  </p>
                </form>
              </section>
            ) : null}
          </>
        ) : null}

        <section className="card" style={{ marginTop: 18 }} id="case-queue">
        <h2 style={{ margin: '0 0 6px 0' }}>Case Queue</h2>
        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
          {hasFleetWorkspace
            ? 'Table-first ticket operations with fleet-aware filtering and direct case navigation.'
            : 'Table-first case tracking for your own tickets, deadlines, and attorney follow-up.'}
        </p>

        <div className="dashboard-filter-pills" style={{ marginBottom: 12 }}>
          <Link
            href={buildDashboardHref(filterQuery, { quick: null, case: null }, '#case-queue')}
            className={`dashboard-filter-pill${!quickFilter ? ' active' : ''}`}
          >
            All Cases
          </Link>
          <Link
            href={buildDashboardHref(filterQuery, { quick: 'attention', case: null }, '#case-queue')}
            className={`dashboard-filter-pill${quickFilter === 'attention' ? ' active' : ''}`}
          >
            Needs Attention
          </Link>
          <Link
            href={buildDashboardHref(filterQuery, { quick: 'pending', case: null }, '#case-queue')}
            className={`dashboard-filter-pill${quickFilter === 'pending' ? ' active' : ''}`}
          >
            Pending Match
          </Link>
          <Link
            href={buildDashboardHref(filterQuery, { quick: 'tasks', case: null }, '#case-queue')}
            className={`dashboard-filter-pill${quickFilter === 'tasks' ? ' active' : ''}`}
          >
            Workflow Tasks
          </Link>
        </div>

        <form method="get" className="form-grid">
          {quickFilter ? <input type="hidden" name="quick" value={quickFilter} /> : null}
          <div className="intake-grid">
            <div>
              <label htmlFor="queue-search">Search</label>
              <input
                id="queue-search"
                name="q"
                defaultValue={searchQ}
                placeholder="Case ID, citation, county, violation, state"
              />
            </div>
            <div>
              <label htmlFor="queue-status">Status</label>
              <select id="queue-status" name="status" defaultValue={statusFilter}>
                <option value="">All statuses</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="queue-county">County</label>
              <select id="queue-county" name="county" defaultValue={countyFilter}>
                <option value="">All counties</option>
                {countyOptions.map((county) => (
                  <option key={county} value={county.toLowerCase()}>
                    {county}
                  </option>
                ))}
              </select>
            </div>
            {hasFleetWorkspace ? (
              <div>
                <label htmlFor="queue-fleet">Fleet</label>
                <select id="queue-fleet" name="fleet" defaultValue={effectiveFleetFilter}>
                  <option value="">All fleets</option>
                  {queueFleetOptions.map((fleet) => (
                    <option key={fleet.id} value={fleet.id}>
                      {fleet.company_name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div>
              <label htmlFor="queue-sort">Sort</label>
              <select id="queue-sort" name="sort" defaultValue={sortKey}>
                <option value="updated_desc">Updated (Newest)</option>
                <option value="updated_asc">Updated (Oldest)</option>
                <option value="court_asc">Court Date (Earliest)</option>
                <option value="court_desc">Court Date (Latest)</option>
                <option value="created_desc">Created (Newest)</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
              <button type="submit" className="secondary">
                Apply
              </button>
              <Link href="/dashboard" className="button-link secondary">
                Clear
              </Link>
            </div>
          </div>
        </form>

        {error ? <p className="error">Error loading cases: {error.message}</p> : null}

        {!filteredCases.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068', fontSize: 14 }}>No cases match current filters.</p>
        ) : (
          <form action={bulkAssignCasesToFleet} style={{ display: 'grid', gap: 12 }}>
            <input type="hidden" name="return_to" value={buildDashboardHref(filterQuery, { case: null }, '#case-queue')} />
            {canReassignCases && queueFleetOptions.length ? (
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  flexWrap: 'wrap',
                  alignItems: 'end',
                  border: '1px solid #dbd6c8',
                  borderRadius: 12,
                  padding: 12,
                  background: '#faf7ef',
                }}
              >
                <div style={{ minWidth: 220 }}>
                  <label htmlFor="bulk-fleet-id">Bulk Action</label>
                  <select id="bulk-fleet-id" name="fleet_id" defaultValue={effectiveFleetFilter || ''} required>
                    <option value="" disabled>
                      Move selected cases to...
                    </option>
                    {queueFleetOptions.map((fleet) => (
                      <option key={fleet.id} value={fleet.id}>
                        {fleet.company_name}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="secondary">
                  Move Selected Cases
                </button>
                <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>
                  Use the checkmarks in the queue to move multiple cases into the same fleet in one step.
                </p>
              </div>
            ) : null}
            <SharedCaseQueueTable
              rows={filteredCases}
              selectedCaseId={selectedCase?.id ?? null}
              showSelection={canReassignCases}
              getSelectionAriaLabel={(item) => `Select case ${item.id}`}
              tableClassName="case-table dashboard-case-table"
              getRowHref={(item) => {
                const rowQuery = new URLSearchParams(stickyQuery.toString())
                rowQuery.set('case', item.id)
                return `/dashboard?${rowQuery.toString()}#selected-case`
              }}
              getRowSubtitle={(item) => item.id}
              renderOpenCell={(item) => {
                const rowQuery = new URLSearchParams(stickyQuery.toString())
                rowQuery.set('case', item.id)
                return (
                  <Link
                    href={`/cases/${item.id}?return_to=${encodeURIComponent(`/dashboard?${rowQuery.toString()}`)}`}
                    className="icon-eye-link"
                    title="Open case"
                    aria-label={`Open case ${item.id}`}
                  >
                    <QueueEyeIcon />
                  </Link>
                )
              }}
              extraColumns={queueExtraColumns}
            />
          </form>
	        )}
	      </section>

      <section className="grid-2" style={{ marginTop: 18 }} id="selected-case">
        <article className="card">
          <h2 style={{ margin: '0 0 6px 0' }}>Selected Case Workspace</h2>
          {!selectedCase ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>Select a case from the queue to load details.</p>
          ) : (
	            <div style={{ display: 'grid', gap: 10 }}>
	              <div style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
	                <p style={{ margin: 0, fontWeight: 700 }}>
	                  {getCaseDisplayDriverName(selectedCase)} | {selectedCase.citation_number ?? selectedCase.id}
	                </p>
	                <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 14 }}>
	                  Violation Date: {getCaseViolationDate(selectedCase) ?? '-'} | State: {selectedCase.state ?? '-'} | Court:{' '}
	                  {selectedCase.court_name ?? '-'}
                </p>
	                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
	                  Court Date: {selectedCase.court_date ?? '-'} | Court Case #: {getCaseCourtCaseNumber(selectedCase) ?? '-'} |
	                  Fleet:{' '}
	                  {selectedCase.fleet_id ? fleetNameById.get(selectedCase.fleet_id) ?? selectedCase.fleet_id.slice(0, 8) : 'Unassigned'}
	                </p>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Link
                    href={`/cases/${selectedCase.id}?return_to=${encodeURIComponent(buildDashboardHref(filterQuery, { case: selectedCase.id }, '#selected-case'))}`}
                    className="button-link secondary"
                  >
                    Open Full Case Details
                  </Link>
                  <Link
                    href={`/cases/${selectedCase.id}?return_to=${encodeURIComponent(buildDashboardHref(filterQuery, { case: selectedCase.id }, '#selected-case'))}#case-messages`}
                    className="dashboard-attention-pill"
                  >
                    {(unreadMessageCountByCase.get(selectedCase.id) ?? 0) || 0} unread messages
                  </Link>
                  <Link
                    href={`/cases/${selectedCase.id}?return_to=${encodeURIComponent(buildDashboardHref(filterQuery, { case: selectedCase.id }, '#selected-case'))}#case-tasks`}
                    className="dashboard-attention-pill"
                  >
                    {taskCountByCase.get(selectedCase.id) ?? 0} open tasks
                  </Link>
                </div>
              </div>

              {role !== 'DRIVER' ? (
                <form action={updateCaseStatus} className="form-grid">
                  <input type="hidden" name="case_id" value={selectedCase.id} />
                  <div>
                    <label htmlFor="dashboard-case-status">Update Status</label>
                    <select id="dashboard-case-status" name="status" defaultValue={selectedCase.status}>
                      {CASE_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit" className="secondary">
                    Save Status
                  </button>
                </form>
              ) : null}

              <form action={uploadCaseDocument} className="form-grid">
                <input type="hidden" name="case_id" value={selectedCase.id} />
                <div>
                  <label htmlFor="dashboard-doc-type">Document Type</label>
                  <select id="dashboard-doc-type" name="doc_type" defaultValue="OTHER">
                    <option value="MVR">MVR</option>
                    <option value="DRIVERS_LICENSE">Driver&apos;s License</option>
                    <option value="CRASH_REPORT">Crash Report</option>
                    <option value="EVIDENCE">Other Evidence</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="dashboard-doc-file">Upload File</label>
                  <input id="dashboard-doc-file" name="document" type="file" required />
                </div>
                <button type="submit" className="primary">
                  Upload Document
                </button>
              </form>

              {(isStaffRole(role) || isAgencyRole(role) || role === 'FLEET') ? (
                <form action={assignCaseToFleet} className="form-grid">
                  <input type="hidden" name="case_id" value={selectedCase.id} />
                  <div>
                    <label htmlFor="assign-fleet-id">Assign to Fleet</label>
                    {fleetOptions.length ? (
                      <select id="assign-fleet-id" name="fleet_id" defaultValue={selectedCase.fleet_id ?? ''} required>
                        <option value="" disabled>
                          Select a fleet
                        </option>
                        {fleetOptions.map((fleet) => (
                          <option key={fleet.id} value={fleet.id}>
                            {fleet.company_name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input id="assign-fleet-id" name="fleet_id" required placeholder="Fleet UUID" />
                    )}
                  </div>
                  <button type="submit" className="secondary">
                    Assign Fleet
                  </button>
                </form>
              ) : null}
            </div>
          )}
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 6px 0' }}>Case Files and Tasks</h2>
          {!selectedCase ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No case selected.</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <h3 style={{ margin: '0 0 6px 0', fontSize: 16 }}>Documents</h3>
                {!selectedDocs.length ? (
                  <p style={{ marginBottom: 0, color: '#5e6068', fontSize: 14 }}>No documents for this case yet.</p>
                ) : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                    {selectedDocs.map((doc) => (
                      <li key={doc.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 8 }}>
                        <p style={{ margin: 0, fontWeight: 700 }}>
                          {doc.doc_type} | {doc.filename ?? '<unnamed>'}
                        </p>
                        <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                          {new Date(doc.created_at).toLocaleString()}
                        </p>
                        <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {doc.signedUrl ? (
                            <>
                              <a href={doc.signedUrl} target="_blank" rel="noreferrer" className="button-link secondary">
                                Open
                              </a>
                              <a
                                href={doc.signedUrl}
                                download={doc.filename || undefined}
                                className="button-link secondary"
                              >
                                Download
                              </a>
                            </>
                          ) : (
                            <span style={{ color: '#5e6068', fontSize: 13 }}>File path unavailable.</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 style={{ margin: '0 0 6px 0', fontSize: 16 }}>Open Tasks for Selected Case</h3>
                {!selectedCaseTasks.length ? (
                  <p style={{ marginBottom: 0, color: '#5e6068', fontSize: 14 }}>No open tasks for this case.</p>
                ) : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                    {selectedCaseTasks.map((task) => (
                      <li key={task.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 8 }}>
                        <p style={{ margin: 0, fontWeight: 700 }}>
                          {task.task_type} <span className="badge">{task.status}</span>
                        </p>
                        <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                          Due: {task.due_at ? new Date(task.due_at).toLocaleString() : 'Not set'}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </article>
      </section>

      {(isAgencyRole(role) || isStaffRole(role)) && (
        <section className="grid-2" style={{ marginTop: 18 }}>
          <article className="card" id="create-fleet">
            <h2 style={{ margin: '0 0 6px 0' }}>Create Fleet</h2>
            <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
              Agency and admin roles can create scoped fleet accounts.
            </p>

            <form action={createFleet} className="form-grid">
              <div>
                <label htmlFor="fleet-company">Fleet Company Name</label>
                <input id="fleet-company" name="company_name" required placeholder="Northline Logistics" />
              </div>
              <div>
                <label htmlFor="fleet-contact">Contact Name</label>
                <input id="fleet-contact" name="contact_name" placeholder="Operations Manager" />
              </div>
              <div>
                <label htmlFor="fleet-address">Address</label>
                <input id="fleet-address" name="address" placeholder="123 Main St, City, ST" />
              </div>
              <div>
                <label htmlFor="fleet-phone">Phone</label>
                <input id="fleet-phone" name="phone" placeholder="(555) 555-5555" />
              </div>
              <div>
                <label htmlFor="fleet-email">Email</label>
                <input id="fleet-email" name="email" type="email" placeholder="fleet@example.com" />
              </div>
              {agencyOptions.length > 1 ? (
                <div>
                  <label htmlFor="fleet-agency-id-select">Agency</label>
                  <select id="fleet-agency-id-select" name="agency_id" defaultValue={agencyOptions[0]?.id ?? ''}>
                    {agencyOptions.map((agency) => (
                      <option key={agency.id} value={agency.id}>
                        {agency.company_name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {isAgencyRole(role) ? (
                <div>
                  <label htmlFor="agency-company-name">Agency Company Name</label>
                  <input
                    id="agency-company-name"
                    name="agency_company_name"
                    placeholder="Required if this is your first fleet in a new agency"
                  />
                </div>
              ) : null}
              {isStaffRole(role) ? (
                <div>
                  <label htmlFor="fleet-agency-id">Agency ID (admin optional)</label>
                  <input id="fleet-agency-id" name="agency_id" placeholder="Target agency UUID" />
                </div>
              ) : null}
              <button type="submit" className="primary">
                Create Fleet
              </button>
            </form>
          </article>

          <article className="card">
            <h2 style={{ margin: '0 0 6px 0' }}>Offer Case to Attorney</h2>
            <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
              Route a case to a specific attorney firm with expiry control.
            </p>

            <form action={offerCaseToAttorney} className="form-grid">
              <div>
                <label htmlFor="offer-case-id">Case ID</label>
                <input
                  id="offer-case-id"
                  name="case_id"
                  required
                  placeholder="Case UUID"
                  defaultValue={selectedCase?.id ?? ''}
                />
              </div>
              <div>
                <label htmlFor="offer-firm-id">Attorney Firm</label>
                <select id="offer-firm-id" name="firm_id" required defaultValue="">
                  <option value="" disabled>
                    Select a firm
                  </option>
                  {(attorneyFirms ?? []).map((firm: { id: string; company_name: string }) => (
                    <option key={firm.id} value={firm.id}>
                      {firm.company_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="expires-hours">Offer Expires (hours)</label>
                <input id="expires-hours" name="expires_hours" type="number" defaultValue={24} min={1} max={168} />
              </div>
              <button type="submit" className="secondary">
                Send Offer
              </button>
            </form>
          </article>
        </section>
      )}

      {(isStaffRole(role) || isAgencyRole(role) || role === 'FLEET') && (
        <section className="card" style={{ marginTop: 18 }}>
          <h2 style={{ margin: '0 0 6px 0' }}>Send Invitation</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Create invite records for role-based account onboarding.
          </p>
          <form action={sendRoleInvite} className="form-grid">
            <div>
              <label htmlFor="invite-email">Email</label>
              <input id="invite-email" name="email" type="email" required placeholder="invitee@example.com" />
            </div>
            <div>
              <label htmlFor="target-role">Target Role</label>
              <select
                id="target-role"
                name="target_role"
                defaultValue={isStaffRole(role) ? 'ATTORNEY' : canInviteAgency ? 'AGENCY' : 'FLEET'}
              >
                {canInviteAgency ? <option value="AGENCY">Agency</option> : null}
                <option value="FLEET">Fleet</option>
                <option value="DRIVER">Driver</option>
                {isStaffRole(role) ? <option value="ATTORNEY">Attorney</option> : null}
              </select>
            </div>
            {isStaffRole(role) ? (
              <div>
                <label htmlFor="invite-agency-id">Agency ID (optional)</label>
                <input id="invite-agency-id" name="agency_id" placeholder="Agency UUID" />
              </div>
            ) : agencyOptions.length > 1 ? (
              <div>
                <label htmlFor="invite-agency-id-select">Agency</label>
                <select id="invite-agency-id-select" name="agency_id" defaultValue={agencyOptions[0]?.id ?? ''}>
                  {agencyOptions.map((agency) => (
                    <option key={agency.id} value={agency.id}>
                      {agency.company_name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {isStaffRole(role) ? (
              <div>
                <label htmlFor="invite-fleet-id">Fleet ID (optional)</label>
                <input id="invite-fleet-id" name="fleet_id" placeholder="Fleet UUID" />
              </div>
            ) : null}
            {isStaffRole(role) ? (
              <div>
                <label htmlFor="invite-firm-id">Firm ID (optional)</label>
                <input id="invite-firm-id" name="firm_id" placeholder="Firm UUID" />
              </div>
            ) : null}
            <button type="submit" className="secondary">
              Create Invite
            </button>
          </form>
        </section>
      )}

      {isAttorneyRole(role) && (
        <section className="card" style={{ marginTop: 18 }}>
          <h2 style={{ margin: '0 0 6px 0' }}>Attorney Offer Inbox</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Accept or decline pending case offers.
          </p>
          {!offerRows.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No pending offers.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {offerRows.map((offer) => (
                <li key={offer.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                  <p style={{ margin: 0, fontWeight: 700 }}>Case: {offer.case_id}</p>
                  <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                    Offered: {new Date(offer.offered_at).toLocaleString()} | Expires:{' '}
                    {new Date(offer.expires_at).toLocaleString()}
                  </p>
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <form action={acceptCaseOffer}>
                      <input type="hidden" name="assignment_id" value={offer.id} />
                      <button type="submit" className="primary">
                        Accept
                      </button>
                    </form>
                    <form action={declineCaseOffer} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input type="hidden" name="assignment_id" value={offer.id} />
                      <input name="decline_reason" placeholder="Reason (optional)" />
                      <button type="submit" className="secondary">
                        Decline
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card" style={{ marginTop: 18 }}>
        <h2 style={{ margin: '0 0 6px 0' }}>Open Workflow Tasks</h2>
        {!taskRows.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No open workflow tasks.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {taskRows.map((task) => (
              <li key={task.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {task.task_type} <span className="badge">{task.status}</span>
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                  Case: {task.case_id} | Due: {task.due_at ? new Date(task.due_at).toLocaleString() : 'Not set'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>
    </AgencyWorkspaceLayout>
  )
}







