import { redirect } from 'next/navigation'
import { AgencyWorkspaceLayout } from '@/app/components/AgencyWorkspaceLayout'
import { getAccessibleFleetRows } from '@/app/lib/server/fleet-access'
import { getEnabledFeaturesForRole, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import type { PlatformRole } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'
import { isAttorneyRole, normalizePlatformRole, roleHasFleetWorkspace } from '@/app/lib/roles'

type ProfileRow = {
  full_name: string | null
  email: string | null
  system_role: string | null
  agency_id: string | null
  fleet_id: string | null
}

type MembershipRow = {
  agency_id?: string | null
  fleet_id?: string | null
}

type DriverIdentityRow = {
  id: string
}

type AgencyRow = {
  id: string
  company_name: string
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function summarizeNames(values: string[]) {
  if (!values.length) return 'None linked yet'
  if (values.length <= 3) return values.join(', ')
  return `${values.slice(0, 3).join(', ')} +${values.length - 3} more`
}

function resolveSettingsRole(params: {
  rawRole: PlatformRole
  hasDriverIdentity: boolean
  agencyMembershipCount: number
  fleetMembershipCount: number
}): PlatformRole {
  if (params.rawRole !== 'NONE') return params.rawRole
  if (params.hasDriverIdentity) return 'DRIVER'
  if (params.fleetMembershipCount > 0) return 'FLEET'
  if (params.agencyMembershipCount > 0) return 'AGENCY'
  return 'NONE'
}

export default async function SettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?message=Please%20sign%20in%20again.')
  }

  const profileById = await supabase
    .from('profiles')
    .select('full_name, email, system_role, agency_id, fleet_id')
    .eq('id', user.id)
    .maybeSingle<ProfileRow>()
  const profileByUserId =
    profileById.data ||
    (
      await supabase
        .from('profiles')
        .select('full_name, email, system_role, agency_id, fleet_id')
        .eq('user_id', user.id)
        .maybeSingle<ProfileRow>()
    ).data

  const [agencyMembershipsRes, fleetMembershipsRes, driverByIdRes, driverByUserIdRes] = await Promise.all([
    supabase.from('agency_memberships').select('agency_id').eq('user_id', user.id).limit(50),
    supabase.from('fleet_memberships').select('fleet_id').eq('user_id', user.id).limit(50),
    supabase.from('drivers').select('id').eq('id', user.id).maybeSingle<DriverIdentityRow>(),
    supabase.from('drivers').select('id').eq('user_id', user.id).maybeSingle<DriverIdentityRow>(),
  ])

  const rawRole = normalizePlatformRole(profileByUserId?.system_role)
  const agencyMembershipIds = uniqueStrings(
    ((agencyMembershipsRes.data ?? []) as MembershipRow[]).map((row) => row.agency_id ?? null)
  )
  const fleetMembershipIds = uniqueStrings(
    ((fleetMembershipsRes.data ?? []) as MembershipRow[]).map((row) => row.fleet_id ?? null)
  )
  const hasDriverIdentity = Boolean(driverByIdRes.data?.id || driverByUserIdRes.data?.id)
  const role = resolveSettingsRole({
    rawRole,
    hasDriverIdentity,
    agencyMembershipCount: agencyMembershipIds.length,
    fleetMembershipCount: fleetMembershipIds.length,
  })
  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
  if (isAttorneyRole(role)) {
    redirect('/attorney/my-firm')
  }

  const fleetRows = await getAccessibleFleetRows(supabase, user.id, { includeArchived: true })
  const hasFleetWorkspace = roleHasFleetWorkspace(role)
  const activeFleetCount = fleetRows.filter((fleet) => fleet.is_active !== false).length
  const archivedFleetCount = fleetRows.filter((fleet) => fleet.is_active === false).length
  const linkedAgencyIds = uniqueStrings([
    profileByUserId?.agency_id,
    ...agencyMembershipIds,
    ...fleetRows.map((fleet) => fleet.agency_id),
  ])
  const agenciesRes = linkedAgencyIds.length
    ? await supabase.from('agencies').select('id, company_name').in('id', linkedAgencyIds).limit(50)
    : { data: [] as AgencyRow[], error: null }
  const agencyRows = (agenciesRes.data ?? []) as AgencyRow[]
  const agencyNameById = new Map(agencyRows.map((agency) => [agency.id, agency.company_name]))
  const linkedAgencyNames = linkedAgencyIds.map((agencyId) => agencyNameById.get(agencyId) ?? agencyId)
  const linkedFleetNames = fleetRows.map((fleet) => fleet.company_name)
  const roleResolutionNote =
    rawRole === 'NONE' && role !== 'NONE'
      ? `Resolved from your accepted driver or organization scope because the stored profile role is still ${rawRole}.`
      : ''

  return (
    <AgencyWorkspaceLayout
      role={role}
      enabledFeatures={enabledFeatures}
      active="settings"
      title="Settings"
      description="Manage account details, organization scope, and billing ownership from one operational settings page."
    >
      <section className="summary-grid">
        <article className="metric-card">
          <p className="metric-label">Workspace Role</p>
          <p className="metric-value">{role}</p>
        </article>
        {hasFleetWorkspace ? (
          <>
            <article className="metric-card">
              <p className="metric-label">Visible Fleets</p>
              <p className="metric-value">{fleetRows.length}</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Active Fleets</p>
              <p className="metric-value">{activeFleetCount}</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Archived Fleets</p>
              <p className="metric-value">{archivedFleetCount}</p>
            </article>
          </>
        ) : (
          <>
            <article className="metric-card">
              <p className="metric-label">Case Access</p>
              <p className="metric-value">{hasDriverIdentity ? 'Driver Linked' : 'Personal'}</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Linked Fleets</p>
              <p className="metric-value">{fleetRows.length}</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Linked Agencies</p>
              <p className="metric-value">{linkedAgencyIds.length}</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Workspace View</p>
              <p className="metric-value">{fleetRows.length ? 'Driver + Shared' : 'Personal'}</p>
            </article>
          </>
        )}
      </section>

      <div className="workspace-stack">
        <section className="card" id="account">
          <div className="section-heading">
            <div>
              <p className="section-eyebrow">Account</p>
              <h2 className="section-title">Identity and session</h2>
            </div>
          </div>
          <div className="settings-grid">
            <div className="settings-item">
              <span>Name</span>
              <strong>{profileByUserId?.full_name || 'No full name on file'}</strong>
            </div>
            <div className="settings-item">
              <span>Email</span>
              <strong>{profileByUserId?.email || user.email || 'No email on file'}</strong>
            </div>
            <div className="settings-item">
              <span>Role</span>
              <strong>{role}</strong>
            </div>
            {roleResolutionNote ? (
              <div className="settings-item">
                <span>Role Sync</span>
                <strong>{roleResolutionNote}</strong>
              </div>
            ) : null}
            <div className="settings-item">
              <span>Theme</span>
              <strong>Use the top-right mode toggle to switch light and dark themes.</strong>
            </div>
          </div>
        </section>

        <section className="card" id="organization">
          <div className="section-heading">
            <div>
              <p className="section-eyebrow">Organization</p>
              <h2 className="section-title">{hasFleetWorkspace ? 'Agency and fleet scope' : 'Case access scope'}</h2>
            </div>
          </div>
          <div className="settings-grid">
            {hasFleetWorkspace ? (
              <>
                <div className="settings-item">
                  <span>Agency ID</span>
                  <strong>{profileByUserId?.agency_id || 'Scoped automatically from your workspace access'}</strong>
                </div>
                <div className="settings-item">
                  <span>Default Fleet</span>
                  <strong>{profileByUserId?.fleet_id || 'No default fleet assigned'}</strong>
                </div>
                <div className="settings-item">
                  <span>Fleet Directory</span>
                  <strong>Manage users, invites, archive state, and ticket routing from My Fleets.</strong>
                </div>
                <div className="settings-item">
                  <span>Case Routing</span>
                  <strong>Open Cases from the sidebar to move tickets between fleets or review attorney progress.</strong>
                </div>
              </>
            ) : (
              <>
                <div className="settings-item">
                  <span>Case Access</span>
                  <strong>
                    {hasDriverIdentity
                      ? 'Cases linked to your driver account are visible here. Pending driver cases can attach during onboarding.'
                      : 'This account does not have a driver identity linked yet.'}
                  </strong>
                </div>
                <div className="settings-item">
                  <span>Linked Fleets</span>
                  <strong>{summarizeNames(linkedFleetNames)}</strong>
                </div>
                <div className="settings-item">
                  <span>Linked Agencies</span>
                  <strong>{summarizeNames(linkedAgencyNames)}</strong>
                </div>
                <div className="settings-item">
                  <span>Ticket Intake</span>
                  <strong>
                    Use Ticket Intake to submit your own citation documents. Case detail pages now show whether a linked fleet can monitor the case.
                  </strong>
                </div>
                <div className="settings-item">
                  <span>Case Queue</span>
                  <strong>Open Cases from the sidebar to review your matters, linked fleet visibility, messages, and court dates.</strong>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="card" id="billing">
          <div className="section-heading">
            <div>
              <p className="section-eyebrow">Billing</p>
              <h2 className="section-title">Billing ownership and support</h2>
            </div>
          </div>
          <div className="settings-grid">
            <div className="settings-item">
              <span>Billing Owner</span>
              <strong>{profileByUserId?.email || user.email || 'Contact support to assign a billing owner'}</strong>
            </div>
            <div className="settings-item">
              <span>Self-serve billing</span>
              <strong>Billing controls are not exposed in this workspace yet.</strong>
            </div>
            <div className="settings-item">
              <span>Support</span>
              <strong>Use case chat for legal operations. For billing changes, contact your CDL Protect administrator.</strong>
            </div>
            <div className="settings-item">
              <span>Next step</span>
                  <strong>
                    {hasFleetWorkspace
                      ? 'Keep fleet assignments current so billing and reporting stay aligned to the right organization.'
                      : 'Use the same email on driver onboarding and invites so pending cases attach to the right driver account.'}
                  </strong>
                </div>
          </div>
        </section>
      </div>
    </AgencyWorkspaceLayout>
  )
}
