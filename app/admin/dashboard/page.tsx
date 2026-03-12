import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CASE_STATUSES } from '@/app/lib/case-status'
import { getCaseDisplayDriverName } from '@/app/lib/cases/display'
import { isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { hydrateCaseDriverNames } from '@/app/lib/server/case-driver-display'
import { createClient } from '@/app/lib/supabase/server'
import {
  createAttorneyAccountInvite,
  deleteCaseAdmin,
  importAttorneyCsv,
  importCountyReferenceCsv,
  importCasesCsv,
  removePendingPlatformInvite,
  sendPlatformInvite,
  toggleAttorneyFirmActive,
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
  notes: string | null
  agency_id?: string | null
  fleet_id?: string | null
  attorney_firm_id?: string | null
  assigned_attorney_user_id?: string | null
  driver_id?: string | null
  court_name?: string | null
  court_address?: string | null
  court_time?: string | null
  metadata?: Record<string, unknown> | null
  updated_at: string
}

type AttorneyFirmRow = {
  id: string
  company_name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  state: string | null
  is_active: boolean
  created_at: string
}

type InviteRow = {
  id: string
  email: string
  target_role: string
  agency_id: string | null
  fleet_id: string | null
  firm_id: string | null
  accepted_at: string | null
  created_at: string
  expires_at: string
}

type AgencyDirectoryRow = {
  id: string
  company_name: string
  contact_name: string | null
  email: string | null
  created_at: string
}

type FleetDirectoryRow = {
  id: string
  agency_id: string | null
  company_name: string
  contact_name: string | null
  email: string | null
  created_at: string
}

type FleetMembershipRow = {
  fleet_id: string
  user_id: string
  role_in_fleet: string
  created_at: string
}

type DriverDirectoryRow = {
  id: string
  user_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
}

type ProfileDirectoryRow = {
  id: string
  user_id: string | null
  email: string | null
  full_name: string | null
  system_role: string | null
}

const CASE_SELECT_VARIANTS = [
  'id, state, county, citation_number, violation_code, violation_date, court_date, court_case_number, attorney_update_date, status, notes, metadata, agency_id, fleet_id, attorney_firm_id, assigned_attorney_user_id, driver_id, court_name, court_address, court_time, updated_at',
  'id, state, county, citation_number, violation_code, violation_date, court_date, court_case_number, status, notes, metadata, agency_id, fleet_id, attorney_firm_id, assigned_attorney_user_id, driver_id, updated_at',
  'id, state, county, citation_number, violation_code, court_date, status, notes, metadata, driver_id, updated_at',
  'id, state, county, citation_number, violation_code, court_date, status, metadata, driver_id, updated_at',
]

function isMissingColumnError(message: string) {
  return /column .* does not exist/i.test(message) || /could not find the '.*' column/i.test(message)
}

async function loadRecentCases(supabase: Awaited<ReturnType<typeof createClient>>) {
  let lastError = ''

  for (const selectClause of CASE_SELECT_VARIANTS) {
    const response = await supabase
      .from('cases')
      .select(selectClause)
      .order('updated_at', { ascending: false })
      .limit(24)

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

function countValue(result: { count: number | null }) {
  return result.count ?? 0
}

function toDateInputValue(value: string | null | undefined) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)

  const parsed = new Date(value)
  if (Number.isNaN(+parsed)) return ''
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
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

  const nowIso = new Date().toISOString()

  const [
    totalCasesRes,
    activeCasesRes,
    pendingAssignmentsRes,
    openTasksRes,
    pendingInvitesRes,
    activeFirmsRes,
    inactiveFirmsRes,
    agenciesRes,
    fleetsRes,
    documentsRes,
    firmsRes,
    invitesRes,
    recentCasesRes,
    staffRpcRes,
    agencyDirectoryRes,
    fleetDirectoryRes,
    fleetMembershipsRes,
    driverDirectoryRes,
    profileDirectoryRes,
  ] = await Promise.all([
    supabase.from('cases').select('*', { count: 'exact', head: true }),
    supabase
      .from('cases')
      .select('*', { count: 'exact', head: true })
      .not('status', 'in', '(CLOSED,CANCELLED,UNABLE_TO_SERVICE)'),
    supabase.from('case_assignments').select('*', { count: 'exact', head: true }).is('accepted_at', null).is('declined_at', null),
    supabase.from('case_tasks').select('*', { count: 'exact', head: true }).in('status', ['OPEN', 'PENDING']),
    supabase
      .from('platform_invites')
      .select('*', { count: 'exact', head: true })
      .is('accepted_at', null)
      .gt('expires_at', nowIso),
    supabase.from('attorney_firms').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('attorney_firms').select('*', { count: 'exact', head: true }).eq('is_active', false),
    supabase.from('agencies').select('*', { count: 'exact', head: true }),
    supabase.from('fleets').select('*', { count: 'exact', head: true }),
    supabase.from('documents').select('*', { count: 'exact', head: true }),
    supabase
      .from('attorney_firms')
      .select('id, company_name, contact_name, email, phone, state, is_active, created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('platform_invites')
      .select('id, email, target_role, agency_id, fleet_id, firm_id, accepted_at, created_at, expires_at')
      .order('created_at', { ascending: false })
      .limit(30),
    loadRecentCases(supabase),
    supabase.rpc('is_staff', { user_id: user.id }),
    supabase.from('agencies').select('id, company_name, contact_name, email, created_at').order('company_name', { ascending: true }).limit(200),
    supabase
      .from('fleets')
      .select('id, agency_id, company_name, contact_name, email, created_at')
      .order('company_name', { ascending: true })
      .limit(400),
    supabase
      .from('fleet_memberships')
      .select('fleet_id, user_id, role_in_fleet, created_at')
      .order('created_at', { ascending: false })
      .limit(500),
    supabase.from('drivers').select('id, user_id, email, first_name, last_name').limit(500),
    supabase.from('profiles').select('id, user_id, email, full_name, system_role').limit(500),
  ])

  const canAccessRpcRes =
    recentCasesRes.data.length > 0
      ? await supabase.rpc('can_access_case', { target_case_id: recentCasesRes.data[0].id })
      : null

  const diagnostics = [
    {
      label: 'Role Guard',
      ok: isStaffRole(role),
      detail: `Role resolved as ${role}.`,
    },
    {
      label: 'RPC is_staff(uuid)',
      ok: !staffRpcRes.error && Boolean(staffRpcRes.data),
      detail: staffRpcRes.error ? staffRpcRes.error.message : `Returned ${String(staffRpcRes.data)}.`,
    },
    {
      label: 'RPC can_access_case(uuid)',
      ok: canAccessRpcRes ? !canAccessRpcRes.error : true,
      detail: canAccessRpcRes
        ? canAccessRpcRes.error
          ? canAccessRpcRes.error.message
          : `Returned ${String(canAccessRpcRes.data)} for sampled case.`
        : 'No sample case available for check.',
    },
    {
      label: 'Case Query Health',
      ok: !recentCasesRes.error,
      detail: recentCasesRes.error ?? `Loaded ${recentCasesRes.data.length} recent case(s).`,
    },
    {
      label: 'Invite Query Health',
      ok: !invitesRes.error,
      detail: invitesRes.error?.message ?? `Loaded ${(invitesRes.data ?? []).length} invite row(s).`,
    },
  ]

  const countErrors = [
    totalCasesRes.error,
    activeCasesRes.error,
    pendingAssignmentsRes.error,
    openTasksRes.error,
    pendingInvitesRes.error,
    activeFirmsRes.error,
    inactiveFirmsRes.error,
    agenciesRes.error,
    fleetsRes.error,
    documentsRes.error,
  ]
    .map((error) => error?.message ?? '')
    .filter(Boolean)

  const totalCases = countValue(totalCasesRes)
  const activeCases = countValue(activeCasesRes)
  const closedCases = Math.max(0, totalCases - activeCases)
  const completionRate = totalCases ? Math.round((closedCases / totalCases) * 100) : 0
  const diagnosticsOkCount = diagnostics.filter((item) => item.ok).length
  const diagnosticsScore = diagnostics.length
    ? Math.round((diagnosticsOkCount / diagnostics.length) * 100)
    : 0
  const agencyDirectory = (agencyDirectoryRes.data ?? []) as AgencyDirectoryRow[]
  const fleetDirectory = (fleetDirectoryRes.data ?? []) as FleetDirectoryRow[]
  const fleetMemberships = (fleetMembershipsRes.data ?? []) as FleetMembershipRow[]
  const driverDirectory = (driverDirectoryRes.data ?? []) as DriverDirectoryRow[]
  const profileDirectory = (profileDirectoryRes.data ?? []) as ProfileDirectoryRow[]
  const fleetsByAgencyId = new Map<string, FleetDirectoryRow[]>()
  for (const fleet of fleetDirectory) {
    const agencyId = fleet.agency_id ?? 'unassigned'
    const bucket = fleetsByAgencyId.get(agencyId) ?? []
    bucket.push(fleet)
    fleetsByAgencyId.set(agencyId, bucket)
  }
  const agencyNameById = new Map(agencyDirectory.map((agency) => [agency.id, agency.company_name]))
  const profileRecordByUserId = new Map<string, ProfileDirectoryRow>()
  for (const profile of profileDirectory) {
    if (profile.user_id) profileRecordByUserId.set(profile.user_id, profile)
    profileRecordByUserId.set(profile.id, profile)
  }
  const driverByUserId = new Map<string, DriverDirectoryRow>()
  for (const driver of driverDirectory) {
    driverByUserId.set(driver.user_id, driver)
    driverByUserId.set(driver.id, driver)
  }
  const recentCases = await hydrateCaseDriverNames(supabase, (recentCasesRes.data ?? []) as AdminCaseRow[])
  const driversByFleetId = new Map<string, string[]>()
  const fleetAdminsByFleetId = new Map<string, string[]>()
  for (const membership of fleetMemberships) {
    const profile = profileRecordByUserId.get(membership.user_id)
    const driver = driverByUserId.get(membership.user_id)
    const label =
      [driver?.first_name, driver?.last_name].filter(Boolean).join(' ').trim() ||
      profile?.full_name ||
      driver?.email ||
      profile?.email ||
      membership.user_id
    const normalizedRole = normalizePlatformRole(profile?.system_role)
    if (driver || normalizedRole === 'DRIVER') {
      const bucket = driversByFleetId.get(membership.fleet_id) ?? []
      bucket.push(label)
      driversByFleetId.set(membership.fleet_id, bucket)
      continue
    }
    if (membership.role_in_fleet === 'fleet_admin' || normalizedRole === 'FLEET') {
      const bucket = fleetAdminsByFleetId.get(membership.fleet_id) ?? []
      bucket.push(label)
      fleetAdminsByFleetId.set(membership.fleet_id, bucket)
    }
  }

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
          <h1 style={{ margin: 0, fontSize: 34 }}>Admin Dashboard</h1>
          <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 14 }}>
            Signed in as <strong>{profileByUserId?.email ?? user.email}</strong> | Role: <strong>{role}</strong>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link href="/admin/users" className="button-link secondary">
            Users &amp; Access
          </Link>
          <Link href="/admin/database" className="button-link secondary">
            Database
          </Link>
          <Link href="/dashboard" className="button-link secondary">
            Main Dashboard
          </Link>
          <Link href="/attorney/dashboard" className="button-link secondary">
            Attorney Portal
          </Link>
          <Link href="/logout" className="button-link secondary">
            Sign Out
          </Link>
        </div>
      </section>

      <AdminMenu active="dashboard" />

      {params?.message ? (
        <section style={{ marginTop: 12 }}>
          <p className="notice">{params.message}</p>
        </section>
      ) : null}

      <section
        style={{
          marginTop: 16,
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        }}
      >
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Total Cases</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{countValue(totalCasesRes)}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Active Cases</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{countValue(activeCasesRes)}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Pending Offers</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{countValue(pendingAssignmentsRes)}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Open Tasks</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{countValue(openTasksRes)}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Pending Invites</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{countValue(pendingInvitesRes)}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Attorney Firms</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 20, fontWeight: 800 }}>
            Active {countValue(activeFirmsRes)} | Inactive {countValue(inactiveFirmsRes)}
          </p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Tenants</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 20, fontWeight: 800 }}>
            Agencies {countValue(agenciesRes)} | Fleets {countValue(fleetsRes)}
          </p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Case Documents</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{countValue(documentsRes)}</p>
        </article>
      </section>

      <section className="grid-2" style={{ marginTop: 16 }}>
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Admin XP</h2>
          <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 14 }}>
            Completion score based on resolved case ratio.
          </p>
          <p style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{completionRate}%</p>
          <div className="xp-track">
            <div className="xp-fill" style={{ width: `${completionRate}%` }} />
          </div>
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Diagnostics Score</h2>
          <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 14 }}>
            Operational confidence across role and RPC checks.
          </p>
          <p style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{diagnosticsScore}%</p>
          <div className="xp-track">
            <div className="xp-fill" style={{ width: `${diagnosticsScore}%` }} />
          </div>
        </article>
      </section>

      <section className="grid-2" style={{ marginTop: 16 }}>
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Agency to Fleet Map</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Admin view of which agency owns which fleets.
          </p>
          {!agencyDirectory.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No agencies found.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {agencyDirectory.map((agency) => {
                const agencyFleets = fleetsByAgencyId.get(agency.id) ?? []
                return (
                  <li key={agency.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>
                      {agency.company_name} <span className="badge">{agencyFleets.length} fleet{agencyFleets.length === 1 ? '' : 's'}</span>
                    </p>
                    <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                      {agency.contact_name || '-'} | {agency.email || '-'}
                    </p>
                    {!agencyFleets.length ? (
                      <p style={{ margin: '6px 0 0 0', color: '#5e6068', fontSize: 13 }}>No fleets linked yet.</p>
                    ) : (
                      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {agencyFleets.map((fleet) => (
                          <span key={fleet.id} className="badge">
                            {fleet.company_name}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Fleet to Driver Map</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Driver and fleet-admin memberships grouped by fleet.
          </p>
          {driverDirectoryRes.error ? (
            <p className="error">Driver directory unavailable: {driverDirectoryRes.error.message}</p>
          ) : !fleetDirectory.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No fleets found.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {fleetDirectory.map((fleet) => {
                const connectedDrivers = driversByFleetId.get(fleet.id) ?? []
                const connectedFleetAdmins = fleetAdminsByFleetId.get(fleet.id) ?? []
                return (
                  <li key={fleet.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>
                      {fleet.company_name} <span className="badge">{connectedDrivers.length} driver{connectedDrivers.length === 1 ? '' : 's'}</span>
                    </p>
                    <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                      Agency: {fleet.agency_id ? agencyNameById.get(fleet.agency_id) ?? fleet.agency_id : 'Unassigned'}
                    </p>
                    <p style={{ margin: '6px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                      Drivers: {connectedDrivers.length ? connectedDrivers.join(', ') : 'No drivers linked'}
                    </p>
                    <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                      Fleet Admins: {connectedFleetAdmins.length ? connectedFleetAdmins.join(', ') : 'No fleet admins linked'}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </article>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Process Diagnostics</h2>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {diagnostics.map((item) => (
            <li
              key={item.label}
              style={{
                border: '1px solid #dbd6c8',
                borderRadius: 10,
                padding: 10,
                background: item.ok ? '#f3f8f3' : '#fff4ef',
              }}
            >
              <p style={{ margin: 0, fontWeight: 700 }}>
                {item.label} {item.ok ? 'OK' : 'ISSUE'}
              </p>
              <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>{item.detail}</p>
            </li>
          ))}
        </ul>

        {countErrors.length ? (
          <p className="error" style={{ marginTop: 10 }}>
            Count query issues: {countErrors.join(' | ')}
          </p>
        ) : null}
      </section>

      <section className="grid-2" style={{ marginTop: 16 }}>
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Send Invite</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Create role-based activation invites for agencies, fleets, drivers, attorneys, and staff.
          </p>

          <form action={sendPlatformInvite} className="form-grid">
            <div>
              <label htmlFor="invite-email">Email</label>
              <input id="invite-email" name="email" type="email" required placeholder="user@example.com" />
            </div>
            <div>
              <label htmlFor="invite-target-role">Target Role</label>
              <select id="invite-target-role" name="target_role" defaultValue="ATTORNEY">
                <option value="ATTORNEY">ATTORNEY</option>
                <option value="AGENCY">AGENCY</option>
                <option value="FLEET">FLEET</option>
                <option value="DRIVER">DRIVER</option>
                <option value="ADMIN">ADMIN</option>
                <option value="OPS">OPS</option>
                <option value="AGENT">AGENT</option>
              </select>
            </div>
            <div>
              <label htmlFor="invite-agency-id">Agency ID (optional)</label>
              <input id="invite-agency-id" name="agency_id" placeholder="UUID" />
            </div>
            <div>
              <label htmlFor="invite-fleet-id">Fleet ID (optional)</label>
              <input id="invite-fleet-id" name="fleet_id" placeholder="UUID" />
            </div>
            <div>
              <label htmlFor="invite-firm-id">Firm ID (optional)</label>
              <input id="invite-firm-id" name="firm_id" placeholder="UUID" />
            </div>
            <button type="submit" className="primary">
              Send Invite
            </button>
          </form>
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Create or Activate Attorney Account</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Create/update firm records, link existing users, and generate attorney activation invites.
          </p>

          <form action={createAttorneyAccountInvite} className="form-grid">
            <div>
              <label htmlFor="firm-id">Firm ID (optional, update existing)</label>
              <input id="firm-id" name="firm_id" placeholder="UUID" />
            </div>
            <div>
              <label htmlFor="firm-company-name">Company Name</label>
              <input id="firm-company-name" name="company_name" placeholder="Smith Traffic Law" />
            </div>
            <div>
              <label htmlFor="firm-contact-name">Contact Name</label>
              <input id="firm-contact-name" name="contact_name" placeholder="Jane Smith" />
            </div>
            <div>
              <label htmlFor="firm-email">Firm Email</label>
              <input id="firm-email" name="email" type="email" placeholder="intake@smithlaw.com" />
            </div>
            <div>
              <label htmlFor="firm-phone">Phone</label>
              <input id="firm-phone" name="phone" placeholder="(555) 555-5555" />
            </div>
            <div>
              <label htmlFor="firm-state">State</label>
              <input id="firm-state" name="state" placeholder="CA" />
            </div>
            <div>
              <label htmlFor="firm-counties">Counties (comma/semicolon separated)</label>
              <input id="firm-counties" name="counties" placeholder="Los Angeles; Orange; San Diego" />
            </div>
            <div>
              <label htmlFor="firm-coverage-notes">Coverage Notes</label>
              <input id="firm-coverage-notes" name="coverage_notes" placeholder="DUI and speeding focus" />
            </div>
            <div>
              <label htmlFor="firm-is-active">Firm Active</label>
              <select id="firm-is-active" name="is_active" defaultValue="true">
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
            <div>
              <label htmlFor="existing-user-id">Existing User ID (optional)</label>
              <input id="existing-user-id" name="existing_user_id" placeholder="UUID" />
            </div>
            <div>
              <label htmlFor="role-in-firm">Role In Firm (for linked user)</label>
              <input id="role-in-firm" name="role_in_firm" defaultValue="attorney_admin" />
            </div>
            <div>
              <label htmlFor="invite-email-attorney">Invite Email (optional)</label>
              <input
                id="invite-email-attorney"
                name="invite_email"
                type="email"
                placeholder="attorney@firm.com"
              />
            </div>
            <button type="submit" className="primary">
              Save + Activate
            </button>
          </form>
        </article>
      </section>

	      <section className="card" style={{ marginTop: 16 }}>
	        <h2 style={{ margin: '0 0 8px 0' }}>Bulk CSV Imports</h2>
	        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
	          Upload attorney contacts/firms and cases in bulk. Imports support schema drift and provide summary feedback.
	        </p>
	        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
	          <a href="/api/templates/cases-csv" className="button-link secondary">
	            Download Cases CSV Template
	          </a>
	          <Link href="/admin/users" className="button-link secondary">
	            Open Users &amp; Access
	          </Link>
	        </div>

	        <div className="grid-2">
          <div style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
            <h3 style={{ margin: '0 0 6px 0' }}>Attorney Contacts CSV</h3>
            <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 13 }}>
              Common columns: company_name, contact_name, email, phone, state, counties, invite_email, user_id.
            </p>
            <form action={importAttorneyCsv} className="form-grid">
              <div>
                <label htmlFor="attorney-csv-file">CSV File</label>
                <input id="attorney-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
              </div>
              <button type="submit" className="secondary">
                Import Attorneys
              </button>
            </form>
          </div>

	          <div style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
	            <h3 style={{ margin: '0 0 6px 0' }}>Cases CSV</h3>
	            <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 13 }}>
	              Common columns: driver_name, state, citation_number, violation_code, violation_date, court_name, court_date,
	              court_case_number, status, agency_id, fleet_id.
	            </p>
            <form action={importCasesCsv} className="form-grid">
              <div>
                <label htmlFor="cases-csv-file">CSV File</label>
                <input id="cases-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
              </div>
              <button type="submit" className="secondary">
                Import Cases
              </button>
            </form>
          </div>
        </div>

        <div style={{ marginTop: 12, border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
          <h3 style={{ margin: '0 0 6px 0' }}>County Reference CSV</h3>
          <p style={{ margin: '0 0 8px 0', color: '#5e6068', fontSize: 13 }}>
            Columns supported: county, state_code, county_display, county_slug, county_uid. This powers attorney
            county selectors in onboarding and My Firm.
          </p>
          <form action={importCountyReferenceCsv} className="form-grid">
            <div>
              <label htmlFor="counties-csv-file">CSV File</label>
              <input id="counties-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
            </div>
            <button type="submit" className="secondary">
              Import Counties
            </button>
          </form>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Attorney Firm Activation</h2>
        {!firmsRes.data?.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No attorney firms found.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
            {(firmsRes.data as AttorneyFirmRow[]).map((firm) => (
              <li key={firm.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {firm.company_name} <span className="badge">{firm.is_active ? 'ACTIVE' : 'INACTIVE'}</span>
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                  {firm.contact_name || '-'} | {firm.email || '-'} | {firm.phone || '-'} | {firm.state || '-'}
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                  Firm ID: {firm.id} | Created: {new Date(firm.created_at).toLocaleString()}
                </p>
                <form action={toggleAttorneyFirmActive} style={{ marginTop: 8 }}>
                  <input type="hidden" name="firm_id" value={firm.id} />
                  <input type="hidden" name="activate" value={String(!firm.is_active)} />
                  <button type="submit" className="secondary">
                    {firm.is_active ? 'Deactivate Firm' : 'Activate Firm'}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Recent Invitations</h2>
        {invitesRes.error ? (
          <p className="error">Error loading invites: {invitesRes.error.message}</p>
        ) : !(invitesRes.data ?? []).length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No invites created yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {(invitesRes.data as InviteRow[]).map((invite) => (
              <li key={invite.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {invite.email} | <span className="badge">{invite.target_role}</span>
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                  Created: {new Date(invite.created_at).toLocaleString()} | Expires:{' '}
                  {new Date(invite.expires_at).toLocaleString()}
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                  Agency: {invite.agency_id || '-'} | Fleet: {invite.fleet_id || '-'} | Firm: {invite.firm_id || '-'}
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                  Status: {invite.accepted_at ? `Accepted ${new Date(invite.accepted_at).toLocaleString()}` : 'Pending'}
                </p>
                {!invite.accepted_at ? (
                  <form action={removePendingPlatformInvite} style={{ marginTop: 8 }}>
                    <input type="hidden" name="invite_id" value={invite.id} />
                    <button type="submit" className="secondary">
                      Remove Pending Activation
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Case Monitoring and Edit</h2>
        {recentCasesRes.error ? (
          <p className="error">Error loading cases: {recentCasesRes.error}</p>
        ) : !recentCases.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No cases found.</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {recentCases.map((caseRow) => (
              <article key={caseRow.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <p style={{ margin: 0, fontWeight: 700 }}>
                    <Link href={`/cases/${caseRow.id}`}>{caseRow.id}</Link>
                  </p>
                  <span className="badge">{caseRow.status}</span>
                </div>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                  Last updated: {new Date(caseRow.updated_at).toLocaleString()}
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                  Driver: {getCaseDisplayDriverName(caseRow)}
                </p>

                <form action={updateCaseAdmin} className="form-grid" style={{ marginTop: 10 }}>
                  <input type="hidden" name="case_id" value={caseRow.id} />

                  <div className="intake-grid">
                    <div>
                      <label htmlFor={`state-${caseRow.id}`}>State</label>
                      <input id={`state-${caseRow.id}`} name="state" defaultValue={caseRow.state ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`county-${caseRow.id}`}>County</label>
                      <input id={`county-${caseRow.id}`} name="county" defaultValue={caseRow.county ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`citation-${caseRow.id}`}>Citation</label>
                      <input
                        id={`citation-${caseRow.id}`}
                        name="citation_number"
                        defaultValue={caseRow.citation_number ?? ''}
                      />
                    </div>
	                    <div>
	                      <label htmlFor={`violation-${caseRow.id}`}>Violation Code</label>
	                      <input
	                        id={`violation-${caseRow.id}`}
	                        name="violation_code"
	                        defaultValue={caseRow.violation_code ?? ''}
	                      />
	                    </div>
	                    <div>
	                      <label htmlFor={`violation-date-${caseRow.id}`}>Violation Date</label>
	                      <input
	                        id={`violation-date-${caseRow.id}`}
	                        name="violation_date"
	                        type="date"
	                        defaultValue={toDateInputValue(caseRow.violation_date)}
	                      />
	                    </div>
	                    <div>
	                      <label htmlFor={`court-date-${caseRow.id}`}>Court Date</label>
	                      <input
	                        id={`court-date-${caseRow.id}`}
                        name="court_date"
                        type="date"
                        defaultValue={toDateInputValue(caseRow.court_date)}
                      />
                    </div>
                    <div>
                      <label htmlFor={`status-${caseRow.id}`}>Status</label>
                      <select id={`status-${caseRow.id}`} name="status" defaultValue={caseRow.status}>
                        {CASE_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`agency-${caseRow.id}`}>Agency ID</label>
                      <input id={`agency-${caseRow.id}`} name="agency_id" defaultValue={caseRow.agency_id ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`fleet-${caseRow.id}`}>Fleet ID</label>
                      <input id={`fleet-${caseRow.id}`} name="fleet_id" defaultValue={caseRow.fleet_id ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`firm-${caseRow.id}`}>Attorney Firm ID</label>
                      <input
                        id={`firm-${caseRow.id}`}
                        name="attorney_firm_id"
                        defaultValue={caseRow.attorney_firm_id ?? ''}
                      />
                    </div>
                    <div>
                      <label htmlFor={`assigned-attorney-${caseRow.id}`}>Assigned Attorney User ID</label>
                      <input
                        id={`assigned-attorney-${caseRow.id}`}
                        name="assigned_attorney_user_id"
                        defaultValue={caseRow.assigned_attorney_user_id ?? ''}
                      />
                    </div>
                    <div>
                      <label htmlFor={`driver-${caseRow.id}`}>Driver User ID</label>
                      <input id={`driver-${caseRow.id}`} name="driver_id" defaultValue={caseRow.driver_id ?? ''} />
                    </div>
	                    <div>
	                      <label htmlFor={`court-name-${caseRow.id}`}>Court Name</label>
	                      <input id={`court-name-${caseRow.id}`} name="court_name" defaultValue={caseRow.court_name ?? ''} />
	                    </div>
	                    <div>
	                      <label htmlFor={`court-case-number-${caseRow.id}`}>Court Case Number</label>
	                      <input
	                        id={`court-case-number-${caseRow.id}`}
	                        name="court_case_number"
	                        defaultValue={caseRow.court_case_number ?? ''}
	                      />
	                    </div>
	                    <div>
	                      <label htmlFor={`court-address-${caseRow.id}`}>Court Address</label>
	                      <input
	                        id={`court-address-${caseRow.id}`}
                        name="court_address"
                        defaultValue={caseRow.court_address ?? ''}
                      />
                    </div>
	                    <div>
	                      <label htmlFor={`court-time-${caseRow.id}`}>Court Time</label>
	                      <input id={`court-time-${caseRow.id}`} name="court_time" defaultValue={caseRow.court_time ?? ''} />
	                    </div>
	                    <div>
	                      <label htmlFor={`attorney-update-date-${caseRow.id}`}>Attorney Updated Date</label>
	                      <input
	                        id={`attorney-update-date-${caseRow.id}`}
	                        name="attorney_update_date"
	                        type="date"
	                        defaultValue={toDateInputValue(caseRow.attorney_update_date)}
	                      />
	                    </div>
                  </div>

                  <div>
                    <label htmlFor={`notes-${caseRow.id}`}>Notes</label>
                    <textarea id={`notes-${caseRow.id}`} name="notes" rows={2} defaultValue={caseRow.notes ?? ''} />
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="submit" className="primary">
                      Save Case
                    </button>
                  </div>
                </form>

                <form action={deleteCaseAdmin} style={{ marginTop: 8 }}>
                  <input type="hidden" name="case_id" value={caseRow.id} />
                  <button type="submit" className="secondary">
                    Delete Case
                  </button>
                </form>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
