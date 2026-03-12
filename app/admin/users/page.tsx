import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ConfirmSubmitButton } from '@/app/_components/ConfirmSubmitButton'
import { PLATFORM_FEATURES } from '@/app/lib/features'
import { loadAdminCustomRoles, type AdminCustomRoleRow } from '@/app/lib/server/admin-custom-roles'
import { getOptionalServiceRoleClient } from '@/app/lib/server/optional-service-role'
import { getEffectiveFeatureMapForRole, groupFeaturesByCategory, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { normalizePlatformRole, isStaffRole } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'
import {
  adminAssignCustomRole,
  adminChangeUserRole,
  adminCreateCustomRole,
  adminDeleteUser,
  adminRemoveCustomRole,
  adminSaveRoleFeatureAccess,
  adminSendPasswordRecoveryEmail,
  adminSetUserSuspension,
  adminSetUserPassword,
  sendPlatformInvite,
} from '../actions'
import { AdminMenu } from '../_components/AdminMenu'

type AdminUserRow = {
  id: string
  user_id: string | null
  email: string | null
  full_name: string | null
  system_role: string | null
  created_at?: string | null
  updated_at?: string | null
}

type InviteAuditRow = {
  id: string
  email: string
  target_role: string
  agency_id: string | null
  fleet_id: string | null
  firm_id: string | null
  invited_by: string | null
  accepted_at: string | null
  created_at: string
  expires_at: string
}

type DirectoryProfileRow = {
  id: string
  user_id: string | null
  email: string | null
  full_name: string | null
}

type FleetDirectoryRow = {
  id: string
  company_name: string
}

type AgencyDirectoryRow = {
  id: string
  company_name: string
}

type AgencyMembershipScopeRow = {
  agency_id: string
  user_id: string | null
}

type FleetMembershipScopeRow = {
  fleet_id: string
  user_id: string | null
}

const ROLE_OPTIONS = ['DRIVER', 'FLEET', 'AGENCY', 'ATTORNEY', 'OPS', 'AGENT', 'ADMIN'] as const

function inviteStatusLabel(invite: InviteAuditRow | null) {
  if (!invite) return 'No invite record'
  if (invite.accepted_at) return `Accepted ${new Date(invite.accepted_at).toLocaleDateString()}`
  return `Pending until ${new Date(invite.expires_at).toLocaleDateString()}`
}

function customRoleBadges(profileId: string, assignmentsByProfileId: Map<string, string[]>, roleById: Map<string, AdminCustomRoleRow>) {
  const assignedRoleIds = assignmentsByProfileId.get(profileId) ?? []
  return assignedRoleIds
    .map((roleId) => roleById.get(roleId))
    .filter((value): value is AdminCustomRoleRow => Boolean(value))
}

function summarizeScope(values: string[]) {
  if (!values.length) return ''
  if (values.length <= 2) return values.join(' | ')
  return `${values.slice(0, 2).join(' | ')} | +${values.length - 2} more`
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; q?: string }>
}) {
  const params = await searchParams
  const query = String(params?.q ?? '').trim().toLowerCase()
  const supabase = await createClient()
  const readClient = getOptionalServiceRoleClient() ?? supabase

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
    redirect('/dashboard?message=Admin%20users%20requires%20ADMIN%2C%20OPS%2C%20or%20AGENT%20role.')
  }

  const [usersRes, invitesRes, directoryRes, fleetsRes, agenciesRes, customRoleState, featureState] = await Promise.all([
    readClient.from('profiles').select('id, user_id, email, full_name, system_role, created_at, updated_at').order('updated_at', { ascending: false }).limit(400),
    readClient
      .from('platform_invites')
      .select('id, email, target_role, agency_id, fleet_id, firm_id, invited_by, accepted_at, created_at, expires_at')
      .order('created_at', { ascending: false })
      .limit(600),
    readClient.from('profiles').select('id, user_id, email, full_name').limit(500),
    readClient.from('fleets').select('id, company_name').limit(400),
    readClient.from('agencies').select('id, company_name').limit(200),
    loadAdminCustomRoles(readClient),
    loadRoleFeatureOverrides(readClient),
  ])

  const allUsers = (usersRes.data ?? []) as AdminUserRow[]
  const inviteRows = (invitesRes.data ?? []) as InviteAuditRow[]
  const directoryRows = (directoryRes.data ?? []) as DirectoryProfileRow[]
  const fleetRows = (fleetsRes.data ?? []) as FleetDirectoryRow[]
  const agencyRows = (agenciesRes.data ?? []) as AgencyDirectoryRow[]
  const customRoles = customRoleState.roles
  const customRoleAssignments = customRoleState.assignments
  const roleById = new Map(customRoles.map((customRole) => [customRole.id, customRole]))
  const assignmentsByProfileId = new Map<string, string[]>()
  for (const assignment of customRoleAssignments) {
    const bucket = assignmentsByProfileId.get(assignment.profile_id) ?? []
    bucket.push(assignment.custom_role_id)
    assignmentsByProfileId.set(assignment.profile_id, bucket)
  }

  const inviterLabelById = new Map<string, string>()
  for (const row of directoryRows) {
    const label = row.full_name || row.email || row.user_id || row.id
    inviterLabelById.set(row.id, label)
    if (row.user_id) inviterLabelById.set(row.user_id, label)
  }

  const latestInviteByEmail = new Map<string, InviteAuditRow>()
  for (const invite of inviteRows) {
    const email = invite.email.toLowerCase()
    if (!latestInviteByEmail.has(email)) latestInviteByEmail.set(email, invite)
  }

  const fleetNameById = new Map(fleetRows.map((fleet) => [fleet.id, fleet.company_name]))
  const agencyNameById = new Map(agencyRows.map((agency) => [agency.id, agency.company_name]))

  const filteredUsers = allUsers.filter((row) => {
    const invite = row.email ? latestInviteByEmail.get(row.email.toLowerCase()) ?? null : null
    const customRoleNames = customRoleBadges(row.id, assignmentsByProfileId, roleById)
      .map((assignedRole) => assignedRole.name)
      .join(' ')
    const inviterLabel = invite?.invited_by ? inviterLabelById.get(invite.invited_by) ?? invite.invited_by : ''
    const haystack = [
      row.id,
      row.user_id ?? '',
      row.email ?? '',
      row.full_name ?? '',
      row.system_role ?? '',
      invite?.target_role ?? '',
      invite?.agency_id ?? '',
      invite?.fleet_id ?? '',
      inviterLabel,
      customRoleNames,
    ]
      .join(' ')
      .toLowerCase()
    return !query || haystack.includes(query)
  })

  const pendingInviteCount = inviteRows.filter((invite) => !invite.accepted_at).length
  const staffUserCount = allUsers.filter((row) => isStaffRole(normalizePlatformRole(row.system_role))).length
  const usersWithCustomRoles = new Set(customRoleAssignments.map((assignment) => assignment.profile_id)).size
  const featureCategories = groupFeaturesByCategory()
  const userIds = [...new Set(allUsers.map((row) => row.user_id).filter(Boolean) as string[])]
  const [agencyMembershipsRes, fleetMembershipsRes] = userIds.length
    ? await Promise.all([
        readClient.from('agency_memberships').select('agency_id, user_id').in('user_id', userIds).limit(1000),
        readClient.from('fleet_memberships').select('fleet_id, user_id').in('user_id', userIds).limit(1000),
      ])
    : [
        { data: [] as AgencyMembershipScopeRow[], error: null },
        { data: [] as FleetMembershipScopeRow[], error: null },
      ]
  const agencyScopesByUserId = new Map<string, string[]>()
  for (const membership of (agencyMembershipsRes.data ?? []) as AgencyMembershipScopeRow[]) {
    if (!membership.user_id) continue
    const label = agencyNameById.get(membership.agency_id) ?? membership.agency_id
    const bucket = agencyScopesByUserId.get(membership.user_id) ?? []
    if (!bucket.includes(label)) bucket.push(label)
    agencyScopesByUserId.set(membership.user_id, bucket)
  }
  const fleetScopesByUserId = new Map<string, string[]>()
  for (const membership of (fleetMembershipsRes.data ?? []) as FleetMembershipScopeRow[]) {
    if (!membership.user_id) continue
    const label = fleetNameById.get(membership.fleet_id) ?? membership.fleet_id
    const bucket = fleetScopesByUserId.get(membership.user_id) ?? []
    if (!bucket.includes(label)) bucket.push(label)
    fleetScopesByUserId.set(membership.user_id, bucket)
  }

  return (
    <div style={{ padding: '18px 0 28px' }}>
      <section style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 34 }}>Users &amp; Access</h1>
          <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 14 }}>
            Manage invitations, password recovery, platform roles, and custom access roles from one admin workspace.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link href="/admin/database" className="button-link secondary">
            Database
          </Link>
          <Link href="/admin/dashboard" className="button-link secondary">
            Back to Overview
          </Link>
        </div>
      </section>

      <AdminMenu active="users" />

      {params?.message ? (
        <section style={{ marginTop: 12 }}>
          <p className="notice">{params.message}</p>
        </section>
      ) : null}

      {customRoleState.migrationPending ? (
        <section style={{ marginTop: 12 }}>
          <p className="notice">
            Custom role tables are not available yet. Apply the latest admin custom-role migration to enable role templates and assignments.
          </p>
        </section>
      ) : null}

      <section className="summary-grid" style={{ marginTop: 16 }}>
        <article className="metric-card">
          <p className="metric-label">Profiles</p>
          <p className="metric-value">{allUsers.length}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Pending Invites</p>
          <p className="metric-value">{pendingInviteCount}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Staff Users</p>
          <p className="metric-value">{staffUserCount}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Custom Role Assignments</p>
          <p className="metric-value">{usersWithCustomRoles}</p>
        </article>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Admin Action Center</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href="#user-directory" className="button-link secondary">
            User Directory
          </a>
          <a href="#invite-user" className="button-link secondary">
            Invite User
          </a>
          <a href="#access-recovery" className="button-link secondary">
            Access Recovery
          </a>
          <a href="#custom-roles" className="button-link secondary">
            Custom Roles
          </a>
          <a href="#role-controls" className="button-link secondary">
            Role Controls
          </a>
          <Link href="/admin/database" className="button-link secondary">
            Bulk Uploads
          </Link>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Search Directory</h2>
        <form method="get" className="form-grid">
          <div className="intake-grid">
            <div>
              <label htmlFor="users-search">Search by email, name, profile ID, role, inviter, or custom role</label>
              <input id="users-search" name="q" defaultValue={query} placeholder="email, uuid, role, inviter, custom role..." />
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
              <button type="submit" className="secondary">
                Apply
              </button>
              <Link href="/admin/users" className="button-link secondary">
                Clear
              </Link>
            </div>
          </div>
        </form>
      </section>

      <section className="grid-2" style={{ marginTop: 16 }}>
        <article className="card" id="invite-user">
          <h2 style={{ margin: '0 0 8px 0' }}>Invite User</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Send role-based invites for attorney, agency, fleet, driver, and staff accounts.
          </p>
          <form action={sendPlatformInvite} className="form-grid">
            <input type="hidden" name="redirect_to" value="/admin/users" />
            <div className="intake-grid">
              <div>
                <label htmlFor="invite-email">Email</label>
                <input id="invite-email" name="email" type="email" required placeholder="user@example.com" />
              </div>
              <div>
                <label htmlFor="invite-target-role">Target Role</label>
                <select id="invite-target-role" name="target_role" defaultValue="ATTORNEY">
                  {ROLE_OPTIONS.map((roleOption) => (
                    <option key={roleOption} value={roleOption}>
                      {roleOption}
                    </option>
                  ))}
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
            </div>
            <button type="submit" className="primary">
              Send Invite
            </button>
          </form>
        </article>

        <article className="card" id="access-recovery">
          <h2 style={{ margin: '0 0 8px 0' }}>Access Recovery</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Send a self-serve password reset email or manually set a temporary password.
          </p>
          <form action={adminSendPasswordRecoveryEmail} className="form-grid">
            <input type="hidden" name="redirect_to" value="/admin/users" />
            <div>
              <label htmlFor="recovery-user-id">Target Auth User ID (preferred)</label>
              <input id="recovery-user-id" name="target_user_id" placeholder="Auth UUID" />
            </div>
            <div>
              <label htmlFor="recovery-email">Or target email</label>
              <input id="recovery-email" name="target_email" type="email" placeholder="user@example.com" />
            </div>
            <button type="submit" className="secondary">
              Send Password Reset Email
            </button>
          </form>

          <form action={adminSetUserPassword} className="form-grid" style={{ marginTop: 16 }}>
            <input type="hidden" name="redirect_to" value="/admin/users" />
            <div>
              <label htmlFor="target-user-id-password">Target Auth User ID</label>
              <input id="target-user-id-password" name="target_user_id" placeholder="Auth UUID" required />
            </div>
            <div>
              <label htmlFor="new-password">Temporary Password</label>
              <input id="new-password" name="new_password" type="password" minLength={8} required />
            </div>
            <div>
              <label htmlFor="confirm-password">Confirm Temporary Password</label>
              <input id="confirm-password" name="confirm_password" type="password" minLength={8} required />
            </div>
            <button type="submit" className="secondary">
              Set Temporary Password
            </button>
          </form>
        </article>
      </section>

      <section className="grid-2" style={{ marginTop: 16 }} id="custom-roles">
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Create Custom Role</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Create reusable role templates for team-specific responsibilities without changing the core platform role.
          </p>
          <form action={adminCreateCustomRole} className="form-grid">
            <input type="hidden" name="redirect_to" value="/admin/users" />
            <div>
              <label htmlFor="custom-role-name">Role Name</label>
              <input id="custom-role-name" name="name" required placeholder="Claims Supervisor" />
            </div>
            <div>
              <label htmlFor="custom-role-slug">Slug (optional)</label>
              <input id="custom-role-slug" name="slug" placeholder="claims-supervisor" />
            </div>
            <div>
              <label htmlFor="custom-role-base-role">Base Platform Role (optional)</label>
              <select id="custom-role-base-role" name="base_role" defaultValue="NONE">
                <option value="NONE">No base role requirement</option>
                {ROLE_OPTIONS.map((roleOption) => (
                  <option key={roleOption} value={roleOption}>
                    {roleOption}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="custom-role-capabilities">Capabilities</label>
              <textarea
                id="custom-role-capabilities"
                name="capability_codes"
                rows={3}
                placeholder="fleet-routing, billing-review, import-management"
              />
            </div>
            <div>
              <label htmlFor="custom-role-description">Description</label>
              <textarea id="custom-role-description" name="description" rows={3} placeholder="What should this role be used for?" />
            </div>
            <button type="submit" className="primary">
              Save Custom Role
            </button>
          </form>
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Custom Role Library</h2>
          {customRoleState.error ? (
            <p className="error">Error loading custom roles: {customRoleState.error}</p>
          ) : !customRoles.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No custom roles created yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {customRoles.map((customRole) => (
                <li key={customRole.id} style={{ border: '1px solid #dbd6c8', borderRadius: 12, padding: 12 }}>
                  <p style={{ margin: 0, fontWeight: 800 }}>
                    {customRole.name} <span className="badge">{customRole.base_role || 'ANY ROLE'}</span>
                  </p>
                  <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 13 }}>{customRole.description || 'No description yet.'}</p>
                  {!!customRole.capability_codes?.length ? (
                    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {customRole.capability_codes.map((capability) => (
                        <span key={capability} className="badge">
                          {capability}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="card" style={{ marginTop: 16 }} id="role-controls">
        <h2 style={{ margin: '0 0 8px 0' }}>Platform Role Feature Controls</h2>
        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
          Enable or disable tested platform functions by role. Default behavior comes from the product design system. Saving a role here writes only the overrides.
        </p>
        {featureState.migrationPending ? (
          <p className="notice">Apply the latest role feature migration to manage role-based function controls.</p>
        ) : featureState.error ? (
          <p className="error">Error loading role feature controls: {featureState.error}</p>
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            {ROLE_OPTIONS.map((roleOption) => {
              const effectiveMap = getEffectiveFeatureMapForRole(roleOption, featureState.overrides)
              const enabledCount = PLATFORM_FEATURES.filter((feature) => effectiveMap[feature.key]).length

              return (
                <article key={roleOption} className="card" style={{ margin: 0 }}>
                  <div className="section-heading" style={{ marginBottom: 12 }}>
                    <div>
                      <p className="section-eyebrow">Role Controls</p>
                      <h3 className="section-title" style={{ marginBottom: 4 }}>{roleOption}</h3>
                      <p style={{ margin: 0, color: '#5e6068', fontSize: 14 }}>
                        {enabledCount} of {PLATFORM_FEATURES.length} tracked functions enabled.
                      </p>
                    </div>
                  </div>
                  <form action={adminSaveRoleFeatureAccess} className="form-grid">
                    <input type="hidden" name="redirect_to" value="/admin/users#role-controls" />
                    <input type="hidden" name="target_role" value={roleOption} />
                    {[...featureCategories.entries()].map(([category, features]) => (
                      <fieldset key={`${roleOption}-${category}`} style={{ border: '1px solid #dbd6c8', borderRadius: 12, padding: 12 }}>
                        <legend style={{ padding: '0 6px', fontWeight: 700 }}>{category}</legend>
                        <div style={{ display: 'grid', gap: 10 }}>
                          {features.map((feature) => {
                            const defaultEnabled = feature.defaultRoles.some((defaultRole) => defaultRole === roleOption)
                            return (
                              <label
                                key={`${roleOption}-${feature.key}`}
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: '20px 1fr',
                                  gap: 10,
                                  alignItems: 'start',
                                }}
                              >
                                <input type="hidden" name={`feature_${feature.key}`} value="0" />
                                <input
                                  type="checkbox"
                                  name={`feature_${feature.key}`}
                                  value="1"
                                  defaultChecked={effectiveMap[feature.key]}
                                  style={{ marginTop: 3 }}
                                />
                                <span>
                                  <strong>{feature.label}</strong>
                                  <span style={{ display: 'block', color: '#5e6068', fontSize: 13 }}>{feature.description}</span>
                                  <span style={{ display: 'block', color: '#8a6f2a', fontSize: 12 }}>
                                    Default: {defaultEnabled ? 'Enabled' : 'Disabled'}
                                  </span>
                                </span>
                              </label>
                            )
                          })}
                        </div>
                      </fieldset>
                    ))}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button type="submit" className="primary">
                        Save {roleOption} Controls
                      </button>
                      <span className="badge">{enabledCount} enabled</span>
                    </div>
                  </form>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }} id="user-directory">
        <h2 style={{ margin: '0 0 8px 0' }}>User Directory</h2>
        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
          Platform role controls the main app shell. Workspace scope reflects accepted agency and fleet memberships, so a driver can still appear inside a fleet roster without becoming a fleet platform role.
        </p>
        {usersRes.error ? (
          <p className="error">Error loading profiles: {usersRes.error.message}</p>
        ) : !filteredUsers.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No profiles match the current search.</p>
        ) : (
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Platform Role</th>
                  <th>Custom Roles</th>
                  <th>Invited By</th>
                  <th>Invite Status</th>
                  <th>Scope</th>
                  <th>Updated</th>
                  <th>Manage</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((row) => {
                  const invite = row.email ? latestInviteByEmail.get(row.email.toLowerCase()) ?? null : null
                  const inviterLabel = invite?.invited_by ? inviterLabelById.get(invite.invited_by) ?? invite.invited_by : 'Unknown'
                  const assignedCustomRoles = customRoleBadges(row.id, assignmentsByProfileId, roleById)
                  const inviteScope = [
                    invite?.agency_id ? `Agency: ${agencyNameById.get(invite.agency_id) ?? invite.agency_id}` : '',
                    invite?.fleet_id ? `Fleet: ${fleetNameById.get(invite.fleet_id) ?? invite.fleet_id}` : '',
                    invite?.firm_id ? `Firm: ${invite.firm_id}` : '',
                  ]
                    .filter(Boolean)
                    .join(' | ')
                  const liveScope = [
                    ...(row.user_id ? (agencyScopesByUserId.get(row.user_id) ?? []).map((label) => `Agency: ${label}`) : []),
                    ...(row.user_id ? (fleetScopesByUserId.get(row.user_id) ?? []).map((label) => `Fleet: ${label}`) : []),
                  ]
                  const scopeLabel = summarizeScope(liveScope) || inviteScope || '-'

                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="case-table-primary">
                          <strong>{row.email || 'No email on file'}</strong>
                          <span className="case-table-secondary">{row.full_name || row.id}</span>
                          <span className="case-table-secondary">{row.user_id || 'No auth user linked yet'}</span>
                        </div>
                      </td>
                      <td>
                        <span className="badge">{normalizePlatformRole(row.system_role)}</span>
                      </td>
                      <td>
                        {!assignedCustomRoles.length ? (
                          <span style={{ color: '#5e6068' }}>No custom roles</span>
                        ) : (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {assignedCustomRoles.map((assignedRole) => (
                              <span key={assignedRole.id} className="badge">
                                {assignedRole.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>{invite ? inviterLabel : '-'}</td>
                      <td>{inviteStatusLabel(invite)}</td>
                      <td>{scopeLabel}</td>
                      <td>{row.updated_at ? new Date(row.updated_at).toLocaleString() : '-'}</td>
                      <td>
                        <details className="table-row-menu">
                          <summary className="table-row-menu-trigger" aria-label={`Manage ${row.email || row.id}`}>
                            Manage
                          </summary>
                          <div className="table-row-menu-panel admin-user-menu-panel">
                            <form action={adminChangeUserRole} className="form-grid">
                              <input type="hidden" name="redirect_to" value="/admin/users" />
                              <input type="hidden" name="target_profile_id" value={row.id} />
                              {row.user_id ? <input type="hidden" name="target_user_id" value={row.user_id} /> : null}
                              <div>
                                <label htmlFor={`target-role-${row.id}`}>Platform Role</label>
                                <select id={`target-role-${row.id}`} name="target_role" defaultValue={normalizePlatformRole(row.system_role)}>
                                  {ROLE_OPTIONS.map((roleOption) => (
                                    <option key={roleOption} value={roleOption}>
                                      {roleOption}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <button type="submit" className="secondary">
                                Save Role
                              </button>
                            </form>

                            <form action={adminSendPasswordRecoveryEmail} className="form-grid">
                              <input type="hidden" name="redirect_to" value="/admin/users" />
                              {row.user_id ? <input type="hidden" name="target_user_id" value={row.user_id} /> : null}
                              {row.email ? <input type="hidden" name="target_email" value={row.email} /> : null}
                              <button type="submit" className="secondary">
                                Send Password Reset
                              </button>
                            </form>

                            <form action={adminSetUserSuspension} className="form-grid">
                              <input type="hidden" name="redirect_to" value="/admin/users" />
                              <input type="hidden" name="target_profile_id" value={row.id} />
                              {row.user_id ? <input type="hidden" name="target_user_id" value={row.user_id} /> : null}
                              <input type="hidden" name="suspend" value="1" />
                              <input type="hidden" name="ban_duration" value="876000h" />
                              <ConfirmSubmitButton
                                className="table-row-menu-item table-row-menu-button"
                                confirmMessage={`Suspend ${row.email || row.id}? This will block sign-in until an admin restores the account.`}
                              >
                                Suspend User
                              </ConfirmSubmitButton>
                            </form>

                            <form action={adminSetUserSuspension} className="form-grid">
                              <input type="hidden" name="redirect_to" value="/admin/users" />
                              <input type="hidden" name="target_profile_id" value={row.id} />
                              {row.user_id ? <input type="hidden" name="target_user_id" value={row.user_id} /> : null}
                              <input type="hidden" name="suspend" value="0" />
                              <ConfirmSubmitButton
                                className="table-row-menu-item table-row-menu-button"
                                confirmMessage={`Restore ${row.email || row.id} if the account is currently suspended?`}
                              >
                                Restore User
                              </ConfirmSubmitButton>
                            </form>

                            {!customRoleState.migrationPending && customRoles.length ? (
                              <form action={adminAssignCustomRole} className="form-grid">
                                <input type="hidden" name="redirect_to" value="/admin/users" />
                                <input type="hidden" name="target_profile_id" value={row.id} />
                                <div>
                                  <label htmlFor={`custom-role-${row.id}`}>Assign Custom Role</label>
                                  <select id={`custom-role-${row.id}`} name="custom_role_id" defaultValue="">
                                    <option value="" disabled>
                                      Select a custom role
                                    </option>
                                    {customRoles.map((customRole) => (
                                      <option key={customRole.id} value={customRole.id}>
                                        {customRole.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <button type="submit" className="secondary">
                                  Assign Custom Role
                                </button>
                              </form>
                            ) : null}

                            {!customRoleState.migrationPending && assignedCustomRoles.length ? (
                              <div className="form-grid">
                                <label>Remove Custom Role</label>
                                <div style={{ display: 'grid', gap: 8 }}>
                                  {assignedCustomRoles.map((assignedRole) => (
                                    <form key={assignedRole.id} action={adminRemoveCustomRole}>
                                      <input type="hidden" name="redirect_to" value="/admin/users" />
                                      <input type="hidden" name="target_profile_id" value={row.id} />
                                      <input type="hidden" name="custom_role_id" value={assignedRole.id} />
                                      <button type="submit" className="ghost">
                                        Remove {assignedRole.name}
                                      </button>
                                    </form>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            <form action={adminDeleteUser} className="form-grid">
                              <input type="hidden" name="redirect_to" value="/admin/users" />
                              <input type="hidden" name="target_profile_id" value={row.id} />
                              {row.user_id ? <input type="hidden" name="target_user_id" value={row.user_id} /> : null}
                              <ConfirmSubmitButton
                                className="table-row-menu-item table-row-menu-button"
                                confirmMessage={`Delete ${row.email || row.id}? This performs a soft auth delete and removes profile or membership links from the admin directory.`}
                              >
                                Delete User
                              </ConfirmSubmitButton>
                            </form>
                          </div>
                        </details>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Recent Invite Audit</h2>
        {!inviteRows.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No invite records found.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {inviteRows.slice(0, 10).map((invite) => (
              <li key={invite.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {invite.email} <span className="badge">{invite.target_role}</span>
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                  Invited by: {invite.invited_by ? inviterLabelById.get(invite.invited_by) ?? invite.invited_by : 'Unknown'}
                </p>
                <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 13 }}>
                  Created: {new Date(invite.created_at).toLocaleString()} | Expires: {new Date(invite.expires_at).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
