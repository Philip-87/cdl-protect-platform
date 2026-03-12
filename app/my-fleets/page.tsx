import Link from 'next/link'
import { unstable_noStore as noStore } from 'next/cache'
import { redirect } from 'next/navigation'
import { ConfirmSubmitButton } from '@/app/_components/ConfirmSubmitButton'
import { AgencyWorkspaceLayout } from '@/app/components/AgencyWorkspaceLayout'
import { getAccessibleAgencyOptions } from '@/app/lib/server/agency-access'
import {
  getAccessibleFleetRows,
  getFleetRowsByIds,
  getFleetRowsCreatedByUser,
  type AccessibleFleetRow,
} from '@/app/lib/server/fleet-access'
import { claimRoleInvitesSafe } from '@/app/lib/server/claim-invites'
import { getEnabledFeaturesForRole, hasPlatformFeature, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { createClient } from '@/app/lib/supabase/server'
import { archiveFleet, createFleet, sendRoleInvite, updateFleet } from '@/app/dashboard/actions'
import {
  isAgencyRole,
  isFleetRole,
  isStaffRole,
  normalizePlatformRole,
  roleCanCreateFleet,
  roleHasFleetWorkspace,
} from '@/app/lib/roles'

type FleetInviteRow = {
  id: string
  email: string
  target_role: string
  fleet_id: string | null
  accepted_at: string | null
  expires_at: string
  created_at: string
}

type CaseFleetRow = {
  id: string
  fleet_id: string | null
  driver_id: string | null
  status: string | null
}

type FleetTaskRow = {
  id: string
  case_id: string
}

type FleetScopedInviteRow = {
  id: string
  email: string
  target_role: string
  fleet_id: string | null
  accepted_at: string | null
  expires_at: string
  created_at: string
}

type FleetMembershipRow = {
  fleet_id: string
  user_id: string | null
  role_in_fleet: string | null
}

type DriverRow = {
  id: string
  user_id: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
}

type FleetDriverRosterItem = {
  key: string
  fleet_id: string
  driver_id: string | null
  email: string | null
  display_name: string
  linked_cases: number
  active_cases: number
  has_membership: boolean
  open_invites: number
  latest_invite_expires_at: string | null
}

function mergeFleetRows(...groups: AccessibleFleetRow[][]) {
  const merged = new Map<string, AccessibleFleetRow>()
  for (const group of groups) {
    for (const fleet of group) {
      if (fleet.id) merged.set(fleet.id, fleet)
    }
  }
  return [...merged.values()].sort((a, b) => a.company_name.localeCompare(b.company_name))
}

function isInviteStillOpen(invite: FleetInviteRow) {
  if (invite.accepted_at) return false
  const expiry = Date.parse(invite.expires_at)
  if (Number.isNaN(expiry)) return true
  return expiry > Date.now()
}

function normalizeEmailValue(value: string | null | undefined) {
  return String(value ?? '').trim().toLowerCase()
}

function getDriverDisplayName(driver: DriverRow | null, fallbackEmail: string | null) {
  const fullName = [driver?.first_name ?? '', driver?.last_name ?? ''].map((value) => value.trim()).filter(Boolean).join(' ')
  return fullName || driver?.email || fallbackEmail || 'Unlinked driver'
}

function getRosterStatusLabel(item: FleetDriverRosterItem) {
  const labels: string[] = []
  if (item.active_cases > 0) {
    labels.push('Active')
  } else if (item.linked_cases > 0) {
    labels.push('Case-linked')
  }
  if (item.has_membership) {
    labels.push('Fleet member')
  }
  if (item.open_invites > 0) {
    labels.push('Invite pending')
  }
  return labels.join(' | ') || 'Record ready'
}

function FleetActionMenu({
  fleet,
  canArchive,
}: {
  fleet: AccessibleFleetRow
  canArchive: boolean
}) {
  return (
    <details className="table-row-menu">
      <summary className="table-row-menu-trigger" aria-label={`Open actions for ${fleet.company_name}`}>
        Menu
      </summary>
      <div className="table-row-menu-panel">
        <Link
          href={`/my-fleets?invite_fleet=${encodeURIComponent(fleet.id)}&invite_role=FLEET#invite-driver`}
          className="table-row-menu-item"
        >
          Invite Fleet User
        </Link>
        <Link
          href={`/my-fleets?invite_fleet=${encodeURIComponent(fleet.id)}&invite_role=DRIVER#invite-driver`}
          className="table-row-menu-item"
        >
          Invite Driver
        </Link>
        <Link href={`/my-fleets?edit=${encodeURIComponent(fleet.id)}#edit-fleet`} className="table-row-menu-item">
          Edit Fleet
        </Link>
        {canArchive ? (
          <form action={archiveFleet}>
            <input type="hidden" name="fleet_id" value={fleet.id} />
            <ConfirmSubmitButton
              className="table-row-menu-item table-row-menu-button"
              confirmMessage="Archive this fleet? If you proceed forward you will not be notified about any future cases regarding this fleet."
            >
              Archive Fleet
            </ConfirmSubmitButton>
          </form>
        ) : null}
      </div>
    </details>
  )
}

export default async function MyFleetsPage({
  searchParams,
}: {
  searchParams: Promise<{
    message?: string
    q?: string
    status?: string
    created?: string
    invite_fleet?: string
    invite_role?: string
    edit?: string
  }>
}) {
  noStore()
  const params = await searchParams
  const searchText = String(params?.q ?? '').trim()
  const searchQ = searchText.toLowerCase()
  const statusFilter = String(params?.status ?? '').trim().toUpperCase()
  const createdFleetId = String(params?.created ?? '').trim()
  const inviteFleetId = String(params?.invite_fleet ?? '').trim()
  const inviteRoleParam = normalizePlatformRole(String(params?.invite_role ?? '').trim())
  const editFleetId = String(params?.edit ?? '').trim()

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  await claimRoleInvitesSafe()

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
  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
  if (!roleHasFleetWorkspace(role)) {
    redirect('/dashboard?message=Fleet%20options%20are%20not%20available%20for%20this%20account.')
  }
  if (!hasPlatformFeature(enabledFeatures, 'fleet_workspace')) {
    redirect('/dashboard?message=Fleet%20workspace%20is%20disabled%20for%20this%20role.')
  }
  const agencyOptions = isAgencyRole(role) ? await getAccessibleAgencyOptions(supabase, user.id) : []
  const accessibleFleets = await getAccessibleFleetRows(supabase, user.id, { includeArchived: true })
  const createdByRows = await getFleetRowsCreatedByUser(supabase, user.id, { includeArchived: true })

  let createdFleetFallback: AccessibleFleetRow[] = []
  if (createdFleetId && !accessibleFleets.some((fleet) => fleet.id === createdFleetId)) {
    createdFleetFallback = await getFleetRowsByIds(supabase, [createdFleetId], { includeArchived: true })
  }

  const fleets = mergeFleetRows(accessibleFleets, createdByRows, createdFleetFallback)
  const fleetIds = fleets.map((fleet) => fleet.id)
  const fleetCasesRes = fleetIds.length
    ? await supabase.from('cases').select('id, fleet_id, driver_id, status').in('fleet_id', fleetIds).limit(4000)
    : { data: [] as CaseFleetRow[], error: null }
  const fleetCases = (fleetCasesRes.data ?? []) as CaseFleetRow[]
  const fleetCaseIds = fleetCases.map((caseRow) => caseRow.id)
  const driverIdsFromCases = [...new Set(fleetCases.map((caseRow) => caseRow.driver_id).filter(Boolean) as string[])]
  const closedStatuses = new Set(['CLOSED', 'CANCELLED', 'UNABLE_TO_SERVICE'])
  const totalCasesByFleet = new Map<string, number>()
  const activeCasesByFleet = new Map<string, number>()
  const fleetIdByCaseId = new Map<string, string>()
  const driverCaseCounts = new Map<string, number>()
  const driverActiveCaseCounts = new Map<string, number>()
  for (const caseRow of fleetCases) {
    if (!caseRow.fleet_id) continue
    fleetIdByCaseId.set(caseRow.id, caseRow.fleet_id)
    totalCasesByFleet.set(caseRow.fleet_id, (totalCasesByFleet.get(caseRow.fleet_id) ?? 0) + 1)
    const status = String(caseRow.status ?? '').toUpperCase()
    if (caseRow.driver_id) {
      const rosterKey = `${caseRow.fleet_id}:${caseRow.driver_id}`
      driverCaseCounts.set(rosterKey, (driverCaseCounts.get(rosterKey) ?? 0) + 1)
      if (!closedStatuses.has(status)) {
        driverActiveCaseCounts.set(rosterKey, (driverActiveCaseCounts.get(rosterKey) ?? 0) + 1)
      }
    }
    if (!closedStatuses.has(status)) {
      activeCasesByFleet.set(caseRow.fleet_id, (activeCasesByFleet.get(caseRow.fleet_id) ?? 0) + 1)
    }
  }
  const fleetTasksRes =
    fleetCaseIds.length > 0
      ? await supabase.from('case_tasks').select('id, case_id').in('case_id', fleetCaseIds).in('status', ['OPEN', 'PENDING']).limit(4000)
      : { data: [] as FleetTaskRow[], error: null }
  const openTasksByFleet = new Map<string, number>()
  for (const task of (fleetTasksRes.data ?? []) as FleetTaskRow[]) {
    const fleetId = fleetIdByCaseId.get(task.case_id)
    if (!fleetId) continue
    openTasksByFleet.set(fleetId, (openTasksByFleet.get(fleetId) ?? 0) + 1)
  }
  const fleetMembershipsRes =
    fleetIds.length > 0
      ? await supabase.from('fleet_memberships').select('fleet_id, user_id, role_in_fleet').in('fleet_id', fleetIds).limit(4000)
      : { data: [] as FleetMembershipRow[], error: null }
  const fleetMemberships = (fleetMembershipsRes.data ?? []) as FleetMembershipRow[]
  const membershipUserIds = [...new Set(fleetMemberships.map((membership) => membership.user_id).filter(Boolean) as string[])]
  const driversByIdRes =
    driverIdsFromCases.length > 0
      ? await supabase.from('drivers').select('id, user_id, email, first_name, last_name').in('id', driverIdsFromCases).limit(4000)
      : { data: [] as DriverRow[], error: null }
  const driversByUserRes =
    membershipUserIds.length > 0
      ? await supabase.from('drivers').select('id, user_id, email, first_name, last_name').in('user_id', membershipUserIds).limit(4000)
      : { data: [] as DriverRow[], error: null }
  const driversById = new Map<string, DriverRow>()
  const driversByUserId = new Map<string, DriverRow>()
  for (const driver of [...((driversByIdRes.data ?? []) as DriverRow[]), ...((driversByUserRes.data ?? []) as DriverRow[])]) {
    if (driver.id && !driversById.has(driver.id)) {
      driversById.set(driver.id, driver)
    }
    if (driver.user_id && !driversByUserId.has(driver.user_id)) {
      driversByUserId.set(driver.user_id, driver)
    }
  }
  const fleetOpenInvitesRes =
    fleetIds.length > 0
      ? await supabase
          .from('platform_invites')
          .select('id, email, target_role, fleet_id, accepted_at, expires_at, created_at')
          .in('fleet_id', fleetIds)
          .is('accepted_at', null)
          .limit(4000)
      : { data: [] as FleetScopedInviteRow[], error: null }
  const fleetDriverInvitesRes =
    fleetIds.length > 0
      ? await supabase
          .from('platform_invites')
          .select('id, email, target_role, fleet_id, accepted_at, expires_at, created_at')
          .in('fleet_id', fleetIds)
          .eq('target_role', 'DRIVER')
          .is('accepted_at', null)
          .limit(4000)
      : { data: [] as FleetScopedInviteRow[], error: null }
  const openInvitesByFleet = new Map<string, number>()
  for (const invite of (fleetOpenInvitesRes.data ?? []) as FleetScopedInviteRow[]) {
    if (!invite.fleet_id) continue
    openInvitesByFleet.set(invite.fleet_id, (openInvitesByFleet.get(invite.fleet_id) ?? 0) + 1)
  }
  const openDriverInvites = (fleetDriverInvitesRes.data ?? []) as FleetScopedInviteRow[]
  const rosterByKey = new Map<string, FleetDriverRosterItem>()
  const rosterEmailIndex = new Map<string, string>()

  function upsertRosterItem(
    fleetId: string,
    driver: DriverRow | null,
    fallbackEmail: string | null,
    patch?: Partial<Omit<FleetDriverRosterItem, 'key' | 'fleet_id' | 'driver_id' | 'email' | 'display_name'>>
  ) {
    const normalizedEmail = normalizeEmailValue(driver?.email || fallbackEmail)
    const baseKey = driver?.id ? `${fleetId}:${driver.id}` : normalizedEmail ? `${fleetId}:invite:${normalizedEmail}` : ''
    if (!baseKey) return
    const existingKey = normalizedEmail ? rosterEmailIndex.get(`${fleetId}:${normalizedEmail}`) ?? baseKey : baseKey
    const existing = rosterByKey.get(existingKey)
    const next: FleetDriverRosterItem = {
      key: existingKey,
      fleet_id: fleetId,
      driver_id: driver?.id ?? existing?.driver_id ?? null,
      email: driver?.email ?? fallbackEmail ?? existing?.email ?? null,
      display_name: getDriverDisplayName(driver ?? null, fallbackEmail ?? existing?.email ?? null),
      linked_cases: patch?.linked_cases ?? existing?.linked_cases ?? 0,
      active_cases: patch?.active_cases ?? existing?.active_cases ?? 0,
      has_membership: patch?.has_membership ?? existing?.has_membership ?? false,
      open_invites: patch?.open_invites ?? existing?.open_invites ?? 0,
      latest_invite_expires_at: patch?.latest_invite_expires_at ?? existing?.latest_invite_expires_at ?? null,
    }
    rosterByKey.set(existingKey, next)
    if (normalizedEmail) {
      rosterEmailIndex.set(`${fleetId}:${normalizedEmail}`, existingKey)
    }
  }

  for (const [rosterKey, linkedCases] of driverCaseCounts.entries()) {
    const [fleetId, driverId] = rosterKey.split(':')
    const driver = driversById.get(driverId) ?? null
    upsertRosterItem(fleetId, driver, null, {
      linked_cases: linkedCases,
      active_cases: driverActiveCaseCounts.get(rosterKey) ?? 0,
    })
  }

  for (const membership of fleetMemberships) {
    if (!membership.fleet_id || !membership.user_id) continue
    if (membership.role_in_fleet && membership.role_in_fleet !== 'member') continue
    const driver = driversByUserId.get(membership.user_id) ?? null
    if (!driver) continue
    const rosterKey = `${membership.fleet_id}:${driver.id}`
    upsertRosterItem(membership.fleet_id, driver, null, {
      linked_cases: rosterByKey.get(rosterKey)?.linked_cases ?? driverCaseCounts.get(rosterKey) ?? 0,
      active_cases: rosterByKey.get(rosterKey)?.active_cases ?? driverActiveCaseCounts.get(rosterKey) ?? 0,
      has_membership: true,
    })
  }

  for (const invite of openDriverInvites) {
    if (!invite.fleet_id) continue
    const normalizedEmail = normalizeEmailValue(invite.email)
    const matchingDriver =
      [...driversById.values()].find((driver) => normalizeEmailValue(driver.email) === normalizedEmail) ?? null
    const lookupKey = normalizedEmail ? rosterEmailIndex.get(`${invite.fleet_id}:${normalizedEmail}`) : null
    const existing = lookupKey ? rosterByKey.get(lookupKey) ?? null : null
    upsertRosterItem(invite.fleet_id, matchingDriver, invite.email, {
      linked_cases: existing?.linked_cases ?? (matchingDriver ? driverCaseCounts.get(`${invite.fleet_id}:${matchingDriver.id}`) ?? 0 : 0),
      active_cases: existing?.active_cases ?? (matchingDriver ? driverActiveCaseCounts.get(`${invite.fleet_id}:${matchingDriver.id}`) ?? 0 : 0),
      has_membership: existing?.has_membership ?? false,
      open_invites: (existing?.open_invites ?? 0) + 1,
      latest_invite_expires_at: invite.expires_at,
    })
  }

  const visibleFleets = fleets.filter((fleet) => {
    const haystack = [fleet.company_name, fleet.contact_name ?? '', fleet.email ?? '', fleet.phone ?? '', fleet.agency_id ?? '']
      .join(' ')
      .toLowerCase()
    const status = fleet.is_active === false ? 'ARCHIVED' : 'ACTIVE'
    if (searchQ && !haystack.includes(searchQ)) return false
    if (statusFilter && status !== statusFilter) return false
    return true
  })
  const visibleFleetIds = new Set(visibleFleets.map((fleet) => fleet.id))
  const rosterItems = [...rosterByKey.values()]
    .filter((item) => visibleFleetIds.has(item.fleet_id))
    .sort((a, b) => {
      const fleetA = fleets.find((fleet) => fleet.id === a.fleet_id)?.company_name ?? a.fleet_id
      const fleetB = fleets.find((fleet) => fleet.id === b.fleet_id)?.company_name ?? b.fleet_id
      if (fleetA !== fleetB) return fleetA.localeCompare(fleetB)
      if (b.active_cases !== a.active_cases) return b.active_cases - a.active_cases
      if (b.linked_cases !== a.linked_cases) return b.linked_cases - a.linked_cases
      return a.display_name.localeCompare(b.display_name)
    })
  const visibleRosterItems = rosterItems.slice(0, 150)
  const rosterOverflowCount = Math.max(rosterItems.length - visibleRosterItems.length, 0)
  const rosterActiveDriverCount = rosterItems.filter((item) => item.active_cases > 0).length
  const unlinkedDriverCaseCount = fleetCases.filter((caseRow) => caseRow.fleet_id && !caseRow.driver_id && visibleFleetIds.has(caseRow.fleet_id)).length
  const inviteVisibilityNotice =
    (fleetOpenInvitesRes.error && /row-level security|permission denied|policy/i.test(fleetOpenInvitesRes.error.message)) ||
    (fleetDriverInvitesRes.error && /row-level security|permission denied|policy/i.test(fleetDriverInvitesRes.error.message))
      ? 'Pending invite visibility is limited until the latest invite-scope migration is applied.'
      : ''

  const canInvite = isStaffRole(role) || isAgencyRole(role) || isFleetRole(role)
  const canCreateFleet = roleCanCreateFleet(role)
  const activeFleetCount = fleets.filter((fleet) => fleet.is_active !== false).length
  const archivedFleetCount = fleets.filter((fleet) => fleet.is_active === false).length
  const fleetStatusMigrationPending = fleets.some((fleet) => fleet.is_active === null)

  const invitesRes = await supabase
    .from('platform_invites')
    .select('id, email, target_role, fleet_id, accepted_at, expires_at, created_at')
    .eq('invited_by', user.id)
    .order('created_at', { ascending: false })
    .limit(8)
  const recentInvites = (invitesRes.data ?? []) as FleetInviteRow[]
  const openInviteCount = recentInvites.filter(isInviteStillOpen).length
  const canInviteAgency = isStaffRole(role) || isAgencyRole(role)
  const defaultInviteRole =
    inviteRoleParam === 'AGENCY' && canInviteAgency
      ? 'AGENCY'
      : inviteRoleParam === 'FLEET'
        ? 'FLEET'
        : 'DRIVER'

  const defaultInviteFleetId =
    [inviteFleetId, createdFleetId, visibleFleets[0]?.id, fleets[0]?.id].find((fleetId) =>
      fleetId ? fleets.some((fleet) => fleet.id === fleetId) : false
    ) ?? ''
  const focusedFleetId = [editFleetId, inviteFleetId, createdFleetId].find((fleetId) =>
    fleetId ? fleets.some((fleet) => fleet.id === fleetId) : false
  )
  const focusedFleet = focusedFleetId ? fleets.find((fleet) => fleet.id === focusedFleetId) ?? null : null

  return (
    <AgencyWorkspaceLayout
      role={role}
      enabledFeatures={enabledFeatures}
      active="fleets"
      title="My Fleets"
      description="Manage fleets, invite users, route tickets, and keep agency case ownership organized from one directory."
      actions={
        <>
          {canCreateFleet ? (
            <a href="#create-fleet" className="button-link primary">
              Create Fleet
            </a>
          ) : null}
          <Link href="/intake" className="button-link secondary">
            Add Traffic Ticket
          </Link>
        </>
      }
    >
      <div className="workspace-stack">
        <nav className="workspace-subnav" aria-label="Fleet sections">
          <a href="#fleet-overview" className="workspace-subnav-link">
            Overview
          </a>
          <a href="#fleet-directory" className="workspace-subnav-link">
            Fleet Directory
          </a>
          <a href="#driver-roster" className="workspace-subnav-link">
            Driver Roster
          </a>
          <a href="#ticket-routing" className="workspace-subnav-link">
            Ticket Routing
          </a>
          {canCreateFleet ? (
            <a href="#create-fleet" className="workspace-subnav-link">
              Create Fleet
            </a>
          ) : null}
          {canInvite ? (
            <a href="#invite-driver" className="workspace-subnav-link">
              Send Invite
            </a>
          ) : null}
        </nav>

        {params?.message ? <p className="notice">{params.message}</p> : null}
        {fleetStatusMigrationPending ? (
          <p className="notice">
            Fleet archive controls are waiting on the latest Supabase fleet-status migration. Fleet visibility and routing still work.
          </p>
        ) : null}
        {inviteVisibilityNotice ? <p className="notice">{inviteVisibilityNotice}</p> : null}

        <section id="fleet-overview" className="summary-grid">
          <article className="metric-card">
            <p className="metric-label">Visible Fleets</p>
            <p className="metric-value">{fleets.length}</p>
          </article>
          <article className="metric-card">
            <p className="metric-label">Active Fleets</p>
            <p className="metric-value">{activeFleetCount}</p>
          </article>
          <article className="metric-card">
            <p className="metric-label">Archived Fleets</p>
            <p className="metric-value">{archivedFleetCount}</p>
          </article>
          <article className="metric-card">
            <p className="metric-label">Open Invites</p>
            <p className="metric-value">{openInviteCount}</p>
          </article>
        </section>

        <section className="card">
          <div className="section-heading">
            <div>
              <p className="section-eyebrow">Quick Actions</p>
              <h2 className="section-title">High-frequency fleet actions</h2>
            </div>
          </div>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Keep the highest-frequency actions visible: create a fleet, open its ticket queue, or launch intake with a fleet preselected.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {canCreateFleet ? (
              <a href="#create-fleet" className="button-link primary">
                Create Fleet
              </a>
            ) : null}
            <a href="#invite-driver" className="button-link secondary">
              Send Role Invite
            </a>
            <a href="/api/templates/cases-csv" className="button-link secondary">
              Download Cases CSV Template
            </a>
            <Link href="/dashboard#case-import" className="button-link secondary">
              Upload Existing Cases
            </Link>
            <Link href="/dashboard?tab=cases#case-queue" className="button-link secondary">
              Open All Tickets
            </Link>
            {fleets[0] ? (
              <Link href={`/dashboard?fleet=${encodeURIComponent(fleets[0].id)}&tab=cases#case-queue`} className="button-link secondary">
                Open First Fleet Queue
              </Link>
            ) : null}
          </div>
        </section>

        {focusedFleet ? (
          <section className="card">
            <h2 style={{ margin: '0 0 8px 0' }}>Focused Fleet</h2>
            <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
              Keep the most common fleet actions one click away while you are managing <strong>{focusedFleet.company_name}</strong>.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link href={`/dashboard?fleet=${encodeURIComponent(focusedFleet.id)}&tab=cases#case-queue`} className="button-link secondary">
                View Related Cases
              </Link>
              <Link href={`/intake?fleet=${encodeURIComponent(focusedFleet.id)}`} className="button-link secondary">
                Add New Case
              </Link>
              <Link
                href={`/my-fleets?invite_fleet=${encodeURIComponent(focusedFleet.id)}&invite_role=FLEET#invite-driver`}
                className="button-link secondary"
              >
                Invite Fleet
              </Link>
              <Link href={`/my-fleets?edit=${encodeURIComponent(focusedFleet.id)}#edit-fleet`} className="button-link primary">
                Edit Fleet Info
              </Link>
            </div>
          </section>
        ) : null}

        <section className="card" id="fleet-directory">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 8,
            }}
          >
            <div>
              <h2 style={{ margin: 0 }}>Fleet Directory</h2>
              <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                Searchable fleet table with direct row actions. This is the fastest way to route tickets and onboard drivers.
              </p>
            </div>
            <form method="get" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
              <div>
                <label htmlFor="fleet-search">Search</label>
                <input
                  id="fleet-search"
                  name="q"
                  defaultValue={searchText}
                  placeholder="Fleet, contact, email, agency"
                  style={{ minWidth: 240 }}
                />
              </div>
              <div>
                <label htmlFor="fleet-status">Status</label>
                <select id="fleet-status" name="status" defaultValue={statusFilter}>
                  <option value="">All statuses</option>
                  <option value="ACTIVE">Active</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>
              {createdFleetId ? <input type="hidden" name="created" value={createdFleetId} /> : null}
              <button type="submit" className="secondary">
                Apply
              </button>
              <Link href="/my-fleets" className="button-link secondary">
                Clear
              </Link>
            </form>
          </div>

          {!fleets.length ? (
            <div style={{ border: '1px dashed #d0c6b3', borderRadius: 12, padding: 18, background: '#faf7ef' }}>
              <p style={{ margin: 0, fontWeight: 700 }}>No fleets are visible yet.</p>
              <p style={{ margin: '6px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                Best practice for an empty fleet workspace is to give a clear next step. Start by creating a fleet, then use the invite
                section to attach drivers or additional fleet users.
              </p>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {canCreateFleet ? (
                  <a href="#create-fleet" className="button-link primary">
                    Create Your First Fleet
                  </a>
                ) : null}
                {canInvite ? (
                  <a href="#invite-driver" className="button-link secondary">
                    Open Invite Form
                  </a>
                ) : null}
              </div>
            </div>
          ) : !visibleFleets.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No fleets match the current filters.</p>
          ) : (
            <div className="table-shell">
              <table className="data-table fleet-directory-table">
                <thead>
                  <tr>
                    <th>Fleet</th>
                    <th>Contact</th>
                    <th>Notifications</th>
                    <th>Case Queue</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFleets.map((fleet) => {
                    const isNewlyCreated = createdFleetId === fleet.id
                    const totalCases = totalCasesByFleet.get(fleet.id) ?? 0
                    const activeCases = activeCasesByFleet.get(fleet.id) ?? 0
                    const openTasks = openTasksByFleet.get(fleet.id) ?? 0
                    const openInvites = openInvitesByFleet.get(fleet.id) ?? 0
                    const resolvedCases = Math.max(totalCases - activeCases, 0)
                    const isEditing = editFleetId === fleet.id

                    return (
                      <tr key={fleet.id}>
                        <td className="fleet-directory-name-cell">
                          <div className="fleet-directory-name">
                            <Link href={`/dashboard?fleet=${encodeURIComponent(fleet.id)}&tab=cases#case-queue`} className="dashboard-table-link">
                              {fleet.company_name}
                            </Link>
                            {isNewlyCreated ? <span className="badge">NEW</span> : null}
                            {isEditing ? <span className="badge">OPEN</span> : null}
                            <span className="badge">{fleet.is_active === false ? 'ARCHIVED' : 'ACTIVE'}</span>
                          </div>
                          <p className="fleet-directory-meta">Agency: {fleet.agency_id || '-'}</p>
                          <p className="fleet-directory-meta">Fleet ID: {fleet.id}</p>
                        </td>
                        <td>
                          <div className="fleet-contact-stack">
                            <strong>{fleet.contact_name || 'No contact name'}</strong>
                            <span>{fleet.email || 'No email on file'}</span>
                            <span>{fleet.phone || 'No phone on file'}</span>
                          </div>
                        </td>
                        <td>
                          <div className="fleet-notification-stack">
                            <span className="fleet-notification-pill">
                              <strong>{activeCases}</strong> active case{activeCases === 1 ? '' : 's'}
                            </span>
                            <span className="fleet-notification-pill">
                              <strong>{openTasks}</strong> open task{openTasks === 1 ? '' : 's'}
                            </span>
                            <span className="fleet-notification-pill">
                              <strong>{openInvites}</strong> open invite{openInvites === 1 ? '' : 's'}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="fleet-queue-stack">
                            <Link href={`/dashboard?fleet=${encodeURIComponent(fleet.id)}&tab=cases#case-queue`} className="dashboard-table-link">
                              {totalCases} total case{totalCases === 1 ? '' : 's'}
                            </Link>
                            <span>{activeCases} active case{activeCases === 1 ? '' : 's'}</span>
                            <span>{resolvedCases} resolved case{resolvedCases === 1 ? '' : 's'}</span>
                          </div>
                        </td>
	                        <td>
	                          <div className="fleet-row-actions">
	                            <Link href={`/dashboard?fleet=${encodeURIComponent(fleet.id)}&tab=cases#case-queue`} className="button-link secondary">
	                              Open Queue
	                            </Link>
	                            <Link href={`/intake?fleet=${encodeURIComponent(fleet.id)}`} className="button-link secondary">
	                              Add Case
	                            </Link>
	                            <FleetActionMenu
	                              fleet={fleet}
	                              canArchive={Boolean(canCreateFleet && fleet.is_active !== null && fleet.is_active !== false)}
	                            />
	                          </div>
	                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" id="driver-roster">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 8,
            }}
          >
            <div>
              <h2 style={{ margin: 0 }}>Driver Roster</h2>
              <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                Case-linked drivers and pending driver invites across the currently visible fleets.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a href="#invite-driver" className="button-link secondary">
                Invite Driver
              </a>
              <Link href="/dashboard?tab=cases#case-queue" className="button-link secondary">
                Open Case Queue
              </Link>
            </div>
          </div>

          <section className="summary-grid" style={{ marginBottom: 14 }}>
            <article className="metric-card">
              <p className="metric-label">Roster Rows</p>
              <p className="metric-value">{rosterItems.length}</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Active Drivers</p>
              <p className="metric-value">{rosterActiveDriverCount}</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Pending Driver Invites</p>
              <p className="metric-value">{openDriverInvites.length}</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Unlinked Cases</p>
              <p className="metric-value">{unlinkedDriverCaseCount}</p>
            </article>
          </section>

          {!visibleFleets.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>Filter at least one fleet into view to inspect the driver roster.</p>
          ) : !rosterItems.length && !openDriverInvites.length ? (
            <div style={{ border: '1px dashed #d0c6b3', borderRadius: 12, padding: 18, background: '#faf7ef' }}>
              <p style={{ margin: 0, fontWeight: 700 }}>No drivers are linked to the visible fleets yet.</p>
              <p style={{ margin: '6px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                Start by attaching a driver invite to a fleet, then link new cases to that driver so the roster becomes operational.
              </p>
            </div>
          ) : (
            <>
              {rosterOverflowCount ? (
                <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                  Showing the first {visibleRosterItems.length} roster rows. Narrow the fleet filters to inspect the remaining {rosterOverflowCount}.
                </p>
              ) : null}
              <div className="table-shell">
                <table className="data-table fleet-directory-table">
                  <thead>
                    <tr>
                      <th>Driver</th>
                      <th>Fleet</th>
                      <th>Access Status</th>
                      <th>Cases</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRosterItems.map((item) => {
                      const fleet = fleets.find((row) => row.id === item.fleet_id) ?? null
                      return (
                        <tr key={item.key}>
                          <td>
                            <div className="fleet-contact-stack">
                              <strong>{item.display_name}</strong>
                              <span>{item.email || 'No email on file'}</span>
                              <span>{item.driver_id || 'Invite only'}</span>
                            </div>
                          </td>
                          <td>
                            <div className="fleet-contact-stack">
                              <strong>{fleet?.company_name || item.fleet_id}</strong>
                              <span>{fleet?.contact_name || 'No contact name'}</span>
                            </div>
                          </td>
                          <td>
                            <div className="fleet-notification-stack">
                              <span className="fleet-notification-pill">{getRosterStatusLabel(item)}</span>
                              {item.latest_invite_expires_at ? (
                                <span className="fleet-notification-pill">
                                  Invite until {new Date(item.latest_invite_expires_at).toLocaleDateString()}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <div className="fleet-queue-stack">
                              <span>{item.linked_cases} linked case{item.linked_cases === 1 ? '' : 's'}</span>
                              <span>{item.active_cases} active case{item.active_cases === 1 ? '' : 's'}</span>
                              <span>{item.open_invites} open invite{item.open_invites === 1 ? '' : 's'}</span>
                            </div>
                          </td>
                          <td>
                            <div className="fleet-row-actions">
                              <Link
                                href={`/dashboard?fleet=${encodeURIComponent(item.fleet_id)}&tab=cases#case-queue`}
                                className="button-link secondary"
                              >
                                Open Queue
                              </Link>
                              <Link
                                href={`/my-fleets?invite_fleet=${encodeURIComponent(item.fleet_id)}&invite_role=DRIVER#invite-driver`}
                                className="button-link secondary"
                              >
                                {item.open_invites ? 'Manage Invite' : 'Invite Driver'}
                              </Link>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="card" id="ticket-routing">
          <h2 style={{ margin: '0 0 8px 0' }}>Ticket Routing by Fleet</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Good fleet workspaces keep ticket routing one click away. These shortcuts open the fleet queue, preselect intake, and jump
            straight into driver invite flow.
          </p>
          {!fleets.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>Create a fleet to unlock routing shortcuts here.</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gap: 12,
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
              }}
            >
              {fleets.slice(0, 6).map((fleet) => (
                <article key={fleet.id} className="card" style={{ padding: 16, boxShadow: 'none' }}>
                  <p style={{ margin: 0, fontWeight: 800 }}>{fleet.company_name}</p>
                  <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                    {fleet.contact_name || 'No contact name'} | {fleet.is_active === false ? 'Archived' : 'Active'}
                  </p>
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Link href={`/dashboard?fleet=${encodeURIComponent(fleet.id)}&tab=cases#case-queue`} className="button-link secondary">
                      View Tickets
                    </Link>
	                    <Link href={`/intake?fleet=${encodeURIComponent(fleet.id)}`} className="button-link secondary">
	                      Add Case
	                    </Link>
	                    <Link
                        href={`/my-fleets?invite_fleet=${encodeURIComponent(fleet.id)}&invite_role=FLEET#invite-driver`}
                        className="button-link secondary"
                      >
	                      Invite Fleet User
                      </Link>
	                    <Link
                        href={`/my-fleets?invite_fleet=${encodeURIComponent(fleet.id)}&invite_role=DRIVER#invite-driver`}
                        className="button-link secondary"
                      >
	                      Invite Driver
	                    </Link>
	                  </div>
	                </article>
              ))}
            </div>
          )}
        </section>

        <section className="grid-2">
          {focusedFleet ? (
            <section className="card" id="edit-fleet">
              <h2 style={{ margin: '0 0 8px 0' }}>Edit Fleet Info</h2>
              <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                Update contact and routing details for <strong>{focusedFleet.company_name}</strong>.
              </p>
              <form action={updateFleet} className="form-grid">
                <input type="hidden" name="return_to" value="/my-fleets" />
                <input type="hidden" name="fleet_id" value={focusedFleet.id} />
                <div>
                  <label htmlFor="edit-fleet-company">Fleet Company Name</label>
                  <input id="edit-fleet-company" name="company_name" required defaultValue={focusedFleet.company_name} />
                </div>
                <div>
                  <label htmlFor="edit-fleet-contact">Contact Name</label>
                  <input id="edit-fleet-contact" name="contact_name" defaultValue={focusedFleet.contact_name ?? ''} />
                </div>
                <div>
                  <label htmlFor="edit-fleet-address">Address</label>
                  <input
                    id="edit-fleet-address"
                    name="address"
                    defaultValue={focusedFleet.address ?? ''}
                    placeholder="123 Main St, City, ST"
                  />
                </div>
                <div>
                  <label htmlFor="edit-fleet-phone">Phone</label>
                  <input id="edit-fleet-phone" name="phone" defaultValue={focusedFleet.phone ?? ''} />
                </div>
                <div>
                  <label htmlFor="edit-fleet-email">Email</label>
                  <input id="edit-fleet-email" name="email" type="email" defaultValue={focusedFleet.email ?? ''} />
                </div>
                <button type="submit" className="primary">
                  Save Fleet Info
                </button>
              </form>
            </section>
          ) : null}

          {canCreateFleet ? (
            <section className="card" id="create-fleet">
              <h2 style={{ margin: '0 0 8px 0' }}>Create New Fleet</h2>
              <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                Capture the core operating details first. Keep this form short so onboarding remains fast.
              </p>
              <form action={createFleet} className="form-grid">
                <input type="hidden" name="return_to" value="/my-fleets" />
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
            </section>
          ) : null}

          {canInvite ? (
            <section className="card" id="invite-driver">
              <h2 style={{ margin: '0 0 8px 0' }}>Send Role Invite</h2>
              <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
                Best practice: attach driver invites to a fleet whenever possible so ticket routing is ready on day one.
              </p>
              <form action={sendRoleInvite} className="form-grid">
                <input type="hidden" name="return_to" value="/my-fleets" />
                <div>
                  <label htmlFor="invite-email">Email</label>
                  <input id="invite-email" name="email" type="email" required placeholder="invitee@example.com" />
                </div>
                <div>
	                  <label htmlFor="target-role">Target Role</label>
                  <select id="target-role" name="target_role" defaultValue={defaultInviteRole}>
                    {canInviteAgency ? <option value="AGENCY">Agency</option> : null}
                    <option value="DRIVER">Driver</option>
                    <option value="FLEET">Fleet</option>
                  </select>
                </div>
                {fleets.length ? (
                  <div>
                    <label htmlFor="invite-fleet-id">Link to Fleet (recommended)</label>
                    <select id="invite-fleet-id" name="fleet_id" defaultValue={defaultInviteFleetId}>
                      <option value="">Agency-level access only</option>
                      {fleets
                        .filter((fleet) => fleet.is_active !== false)
                        .map((fleet) => (
                          <option key={fleet.id} value={fleet.id}>
                            {fleet.company_name}
                          </option>
                        ))}
                    </select>
                  </div>
                ) : isStaffRole(role) ? (
                  <div>
                    <label htmlFor="invite-fleet-id">Fleet ID (optional)</label>
                    <input id="invite-fleet-id" name="fleet_id" placeholder="Fleet UUID" />
                  </div>
                ) : null}
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
                <button type="submit" className="secondary">
                  Create Invite
                </button>
              </form>
            </section>
          ) : null}
        </section>

        <section className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Recent Invite Activity</h2>
          {!recentInvites.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No invites created from this workspace yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {recentInvites.map((invite) => {
                const fleetName = fleets.find((fleet) => fleet.id === invite.fleet_id)?.company_name ?? null
                return (
                  <li key={invite.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>
                      {invite.email} <span className="badge">{invite.target_role}</span>
                    </p>
                    <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                      Fleet: {fleetName ?? 'Agency level'} | Created: {new Date(invite.created_at).toLocaleString()}
                    </p>
                    <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                      {invite.accepted_at
                        ? `Accepted ${new Date(invite.accepted_at).toLocaleString()}`
                        : `Open until ${new Date(invite.expires_at).toLocaleString()}`}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </AgencyWorkspaceLayout>
  )
}
