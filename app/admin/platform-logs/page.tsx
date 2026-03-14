import Link from 'next/link'
import { redirect } from 'next/navigation'
import { SignOutForm } from '@/app/components/SignOutForm'
import { isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'
import { AdminMenu } from '../_components/AdminMenu'

type PlatformLogRow = {
  id: string
  created_at: string
  severity: string
  event_type: string
  source: string
  message: string
  actor_user_id: string | null
  target_user_id: string | null
  request_path: string | null
  metadata: Record<string, unknown> | null
}

type ProfileRow = {
  id: string
  user_id: string | null
  email: string | null
  full_name: string | null
}

export default async function AdminPlatformLogsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    user_id?: string
    severity?: string
    event_type?: string
    message?: string
  }>
}) {
  const params = await searchParams
  const q = String(params?.q ?? '').trim().toLowerCase()
  const severityFilter = String(params?.severity ?? '').trim().toUpperCase()
  const userFilter = String(params?.user_id ?? '').trim()
  const eventTypeFilter = String(params?.event_type ?? '').trim().toUpperCase()
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
    redirect('/dashboard?message=Admin%20platform%20logs%20requires%20ADMIN%2C%20OPS%2C%20or%20AGENT%20role.')
  }

  const [logsRes, usersRes] = await Promise.all([
    supabase.from('platform_logs').select('*').order('created_at', { ascending: false }).limit(400),
    supabase.from('profiles').select('id, user_id, email, full_name').order('updated_at', { ascending: false }).limit(400),
  ])

  const logs = (logsRes.data ?? []) as PlatformLogRow[]
  const users = (usersRes.data ?? []) as ProfileRow[]

  const userOptions = users
    .map((row) => ({
      key: row.user_id || row.id,
      label: row.email || row.full_name || row.user_id || row.id,
    }))
    .filter((row) => row.key)

  const profileLookup = new Map<string, ProfileRow>()
  for (const profile of users) {
    profileLookup.set(profile.id, profile)
    if (profile.user_id) profileLookup.set(profile.user_id, profile)
  }

  const filteredLogs = logs.filter((row) => {
    if (severityFilter && String(row.severity || '').toUpperCase() !== severityFilter) return false
    if (eventTypeFilter && String(row.event_type || '').toUpperCase() !== eventTypeFilter) return false
    if (userFilter && row.actor_user_id !== userFilter && row.target_user_id !== userFilter) return false

    if (q) {
      const haystack = [
        row.id,
        row.event_type,
        row.source,
        row.message,
        row.severity,
        row.request_path || '',
        row.actor_user_id || '',
        row.target_user_id || '',
        row.metadata ? JSON.stringify(row.metadata) : '',
      ]
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(q)) return false
    }

    return true
  })

  const severityOptions = [...new Set(logs.map((row) => String(row.severity || '').toUpperCase()).filter(Boolean))].sort()
  const typeOptions = [...new Set(logs.map((row) => String(row.event_type || '').toUpperCase()).filter(Boolean))].sort()

  return (
    <div style={{ padding: '18px 0 28px' }}>
      <section style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 34 }}>Platform Logs</h1>
          <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 14 }}>
            Review auth, action, and request-level logs for debugging and operations.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link href="/admin/dashboard" className="button-link secondary">
            Back to Overview
          </Link>
          <SignOutForm className="button-link secondary">Sign Out</SignOutForm>
        </div>
      </section>

      <AdminMenu active="logs" />

      {params?.message ? (
        <section style={{ marginTop: 12 }}>
          <p className="notice">{params.message}</p>
        </section>
      ) : null}

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Filters</h2>
        <form method="get" className="form-grid">
          <div className="intake-grid">
            <div>
              <label htmlFor="logs-q">Search</label>
              <input id="logs-q" name="q" defaultValue={q} placeholder="message, source, event type, metadata..." />
            </div>
            <div>
              <label htmlFor="logs-user">User</label>
              <select id="logs-user" name="user_id" defaultValue={userFilter}>
                <option value="">Any user</option>
                {userOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="logs-severity">Severity</label>
              <select id="logs-severity" name="severity" defaultValue={severityFilter}>
                <option value="">Any severity</option>
                {severityOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="logs-type">Event Type</label>
              <select id="logs-type" name="event_type" defaultValue={eventTypeFilter}>
                <option value="">Any event</option>
                {typeOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
              <button type="submit" className="secondary">
                Apply
              </button>
              <Link href="/admin/platform-logs" className="button-link secondary">
                Clear
              </Link>
            </div>
          </div>
        </form>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>Logs</h2>
        {logsRes.error ? (
          <p className="error">Error loading platform logs: {logsRes.error.message}</p>
        ) : !filteredLogs.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No logs match the selected filters.</p>
        ) : (
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Severity</th>
                  <th>Event</th>
                  <th>Source</th>
                  <th>Message</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((row) => {
                  const actorProfile = row.actor_user_id ? profileLookup.get(row.actor_user_id) : null
                  const targetProfile = row.target_user_id ? profileLookup.get(row.target_user_id) : null

                  return (
                    <tr key={row.id}>
                      <td>{new Date(row.created_at).toLocaleString()}</td>
                      <td>
                        <span className="badge">{row.severity}</span>
                      </td>
                      <td>{row.event_type}</td>
                      <td>{row.source}</td>
                      <td>{row.message}</td>
                      <td>{actorProfile?.email || row.actor_user_id || '-'}</td>
                      <td>{targetProfile?.email || row.target_user_id || '-'}</td>
                      <td>{row.request_path || '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
