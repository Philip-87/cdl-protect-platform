import Link from 'next/link'
import { redirect } from 'next/navigation'
import { isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'
import {
  createAttorneyAccountInvite,
  importCountyReferenceCsv,
  importAttorneyCsv,
  removePendingPlatformInvite,
  sendPlatformInvite,
  toggleAttorneyFirmActive,
} from '../actions'
import { AdminMenu } from '../_components/AdminMenu'

type AttorneyFirmRow = {
  id: string
  company_name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  state: string | null
  is_active: boolean
  counties: unknown
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

function countCoverageUnits(counties: unknown) {
  if (!counties) return 0
  if (Array.isArray(counties)) return counties.length
  if (typeof counties === 'string') {
    const parts = counties
      .split(/[;,|]/)
      .map((value) => value.trim())
      .filter(Boolean)
    return parts.length
  }
  return 1
}

export default async function AdminAttorneyNetworkPage({
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

  const [firmsRes, invitesRes, membershipsRes, pendingInvitesRes] = await Promise.all([
    supabase
      .from('attorney_firms')
      .select('id, company_name, contact_name, email, phone, state, is_active, counties, created_at')
      .order('created_at', { ascending: false })
      .limit(80),
    supabase
      .from('platform_invites')
      .select('id, email, target_role, agency_id, fleet_id, firm_id, accepted_at, created_at, expires_at')
      .eq('target_role', 'ATTORNEY')
      .order('created_at', { ascending: false })
      .limit(80),
    supabase.from('attorney_firm_memberships').select('*', { count: 'exact', head: true }),
    supabase
      .from('platform_invites')
      .select('*', { count: 'exact', head: true })
      .eq('target_role', 'ATTORNEY')
      .is('accepted_at', null)
      .gt('expires_at', nowIso),
  ])

  const firms = (firmsRes.data ?? []) as AttorneyFirmRow[]
  const invites = (invitesRes.data ?? []) as InviteRow[]

  const activeFirmsCount = firms.filter((firm) => firm.is_active).length
  const inactiveFirmsCount = firms.filter((firm) => !firm.is_active).length
  const networkCoverageCount = firms.reduce((sum, firm) => sum + countCoverageUnits(firm.counties), 0)
  const networkHealthScore = Math.max(
    0,
    Math.min(
      100,
      Math.round((activeFirmsCount * 4 + (membershipsRes.count ?? 0) * 2 + networkCoverageCount) / 3)
    )
  )

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
          <h1 style={{ margin: 0, fontSize: 34 }}>Manage Attorney Network</h1>
          <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 14 }}>
            Build attorney coverage, activate firms, and send profile invitations.
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

      <AdminMenu active="network" />

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
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Active Firms</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{activeFirmsCount}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Inactive Firms</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{inactiveFirmsCount}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Pending Attorney Invites</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{pendingInvitesRes.count ?? 0}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>Network Health XP</p>
          <p style={{ margin: '8px 0 0 0', fontSize: 28, fontWeight: 800 }}>{networkHealthScore}</p>
          <div className="xp-track">
            <div className="xp-fill" style={{ width: `${networkHealthScore}%` }} />
          </div>
        </article>
      </section>

      <section className="grid-2" style={{ marginTop: 14 }}>
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Send Invite</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Send role-based profile invites for attorneys, agencies, fleets, and staff users.
          </p>

          <form action={sendPlatformInvite} className="form-grid">
            <input type="hidden" name="redirect_to" value="/admin/attorney-network" />
            <div>
              <label htmlFor="network-invite-email">Email</label>
              <input id="network-invite-email" name="email" type="email" required placeholder="user@example.com" />
            </div>
            <div>
              <label htmlFor="network-invite-target-role">Target Role</label>
              <select id="network-invite-target-role" name="target_role" defaultValue="ATTORNEY">
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
              <label htmlFor="network-invite-agency-id">Agency ID (optional)</label>
              <input id="network-invite-agency-id" name="agency_id" placeholder="UUID" />
            </div>
            <div>
              <label htmlFor="network-invite-fleet-id">Fleet ID (optional)</label>
              <input id="network-invite-fleet-id" name="fleet_id" placeholder="UUID" />
            </div>
            <div>
              <label htmlFor="network-invite-firm-id">Firm ID (optional)</label>
              <input id="network-invite-firm-id" name="firm_id" placeholder="UUID" />
            </div>
            <button type="submit" className="primary">
              Send Invite
            </button>
          </form>
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Create or Activate Attorney Account</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Create/update firm records, attach users, and trigger attorney activation invites.
          </p>

          <form action={createAttorneyAccountInvite} className="form-grid">
            <input type="hidden" name="redirect_to" value="/admin/attorney-network" />
            <div>
              <label htmlFor="network-firm-id">Firm ID (optional)</label>
              <input id="network-firm-id" name="firm_id" placeholder="UUID" />
            </div>
            <div>
              <label htmlFor="network-company-name">Company Name</label>
              <input id="network-company-name" name="company_name" placeholder="Smith Traffic Law" />
            </div>
            <div>
              <label htmlFor="network-contact-name">Contact Name</label>
              <input id="network-contact-name" name="contact_name" placeholder="Jane Smith" />
            </div>
            <div>
              <label htmlFor="network-firm-email">Firm Email</label>
              <input id="network-firm-email" name="email" type="email" placeholder="intake@smithlaw.com" />
            </div>
            <div>
              <label htmlFor="network-firm-phone">Phone</label>
              <input id="network-firm-phone" name="phone" placeholder="(555) 555-5555" />
            </div>
            <div>
              <label htmlFor="network-firm-state">State</label>
              <input id="network-firm-state" name="state" placeholder="CA" />
            </div>
            <div>
              <label htmlFor="network-firm-counties">Counties / ZIP coverage</label>
              <input id="network-firm-counties" name="counties" placeholder="Los Angeles; Orange; San Diego" />
            </div>
            <div>
              <label htmlFor="network-firm-notes">Coverage Notes</label>
              <input id="network-firm-notes" name="coverage_notes" placeholder="DUI and speeding focus" />
            </div>
            <div>
              <label htmlFor="network-firm-active">Firm Active</label>
              <select id="network-firm-active" name="is_active" defaultValue="true">
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
            <div>
              <label htmlFor="network-existing-user-id">Existing User ID (optional)</label>
              <input id="network-existing-user-id" name="existing_user_id" placeholder="UUID" />
            </div>
            <div>
              <label htmlFor="network-role-in-firm">Role In Firm</label>
              <input id="network-role-in-firm" name="role_in_firm" defaultValue="attorney_admin" />
            </div>
            <div>
              <label htmlFor="network-invite-email-attorney">Invite Email (optional)</label>
              <input
                id="network-invite-email-attorney"
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

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>County Reference Import</h2>
        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
          Upload county reference CSV to power attorney state/county selectors.
        </p>
        <form action={importCountyReferenceCsv} className="form-grid">
          <input type="hidden" name="redirect_to" value="/admin/attorney-network" />
          <div>
            <label htmlFor="network-counties-csv-file">CSV File</label>
            <input id="network-counties-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
          </div>
          <button type="submit" className="secondary">
            Import Counties
          </button>
        </form>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Attorney CSV Upload</h2>
        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
          Designed for your sample headers like <code>ATTORNEY NAME</code>, <code>EMAIL</code>, <code>PHONE NUMBER</code>,{' '}
          <code>State</code>, and <code>Counties / ZIP</code>.
        </p>
        <form action={importAttorneyCsv} className="form-grid">
          <input type="hidden" name="redirect_to" value="/admin/attorney-network" />
          <div>
            <label htmlFor="network-attorney-csv-file">Attorney network CSV file</label>
            <input id="network-attorney-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
          </div>
          <button type="submit" className="secondary">
            Import Attorney Network
          </button>
        </form>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Attorney Firms</h2>
        {!firms.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No attorney firms found.</p>
        ) : (
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Firm</th>
                  <th>Contact</th>
                  <th>State</th>
                  <th>Status</th>
                  <th>Coverage Units</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {firms.map((firm) => (
                  <tr key={firm.id}>
                    <td>
                      <strong>{firm.company_name}</strong>
                      <div style={{ fontSize: 12, color: '#5e6068', marginTop: 2 }}>{firm.id}</div>
                    </td>
                    <td>
                      {firm.contact_name || '-'}
                      <div style={{ fontSize: 12, color: '#5e6068', marginTop: 2 }}>{firm.email || '-'}</div>
                    </td>
                    <td>{firm.state || '-'}</td>
                    <td>
                      <span className="badge">{firm.is_active ? 'ACTIVE' : 'INACTIVE'}</span>
                    </td>
                    <td>{countCoverageUnits(firm.counties)}</td>
                    <td>
                      <form action={toggleAttorneyFirmActive}>
                        <input type="hidden" name="redirect_to" value="/admin/attorney-network" />
                        <input type="hidden" name="firm_id" value={firm.id} />
                        <input type="hidden" name="activate" value={String(!firm.is_active)} />
                        <button type="submit" className="secondary">
                          {firm.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Recent Attorney Invites</h2>
        {!invites.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No attorney invites found.</p>
        ) : (
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Firm ID</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr key={invite.id}>
                    <td>{invite.email}</td>
                    <td>{invite.firm_id || '-'}</td>
                    <td>{new Date(invite.created_at).toLocaleString()}</td>
                    <td>{new Date(invite.expires_at).toLocaleString()}</td>
                    <td>{invite.accepted_at ? `Accepted ${new Date(invite.accepted_at).toLocaleString()}` : 'Pending'}</td>
                    <td>
                      {!invite.accepted_at ? (
                        <form action={removePendingPlatformInvite}>
                          <input type="hidden" name="redirect_to" value="/admin/attorney-network" />
                          <input type="hidden" name="invite_id" value={invite.id} />
                          <button type="submit" className="secondary">
                            Remove Pending Activation
                          </button>
                        </form>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
