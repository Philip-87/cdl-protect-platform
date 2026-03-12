import Link from 'next/link'
import { unstable_noStore as noStore } from 'next/cache'
import { redirect } from 'next/navigation'
import { AgencyWorkspaceLayout } from '@/app/components/AgencyWorkspaceLayout'
import { markWorkspaceNotificationRead } from '@/app/dashboard/actions'
import { claimRoleInvitesSafe } from '@/app/lib/server/claim-invites'
import { getEnabledFeaturesForRole, hasPlatformFeature, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { isAttorneyRole, normalizePlatformRole } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'

type NotificationRow = {
  id: string
  case_id: string | null
  category: string
  title: string
  body: string
  href: string | null
  read_at: string | null
  created_at: string
}

function isMissingNotificationSchema(message: string) {
  return /does not exist|schema cache/i.test(message)
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  noStore()
  const params = await searchParams
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
  if (isAttorneyRole(role)) {
    redirect('/attorney/reminders')
  }

  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
  if (!hasPlatformFeature(enabledFeatures, 'notification_inbox')) {
    redirect('/dashboard?message=Notification%20inbox%20is%20disabled%20for%20this%20role.')
  }

  const notificationsRes = await supabase
    .from('in_app_notifications')
    .select('id, case_id, category, title, body, href, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  const notifications =
    notificationsRes.error && isMissingNotificationSchema(notificationsRes.error.message)
      ? ([] as NotificationRow[])
      : ((notificationsRes.data ?? []) as NotificationRow[])
  const notificationNotice =
    notificationsRes.error && isMissingNotificationSchema(notificationsRes.error.message)
      ? 'Apply the calendar sync + notifications migration to unlock the shared inbox.'
      : notificationsRes.error
        ? `Notifications are unavailable: ${notificationsRes.error.message}`
        : ''
  const unreadNotifications = notifications.filter((item) => !item.read_at)
  const categoryCount = new Set(notifications.map((item) => item.category).filter(Boolean)).size

  return (
    <AgencyWorkspaceLayout
      role={role}
      enabledFeatures={enabledFeatures}
      active="notifications"
      title="Notifications"
      description="Review case updates, payment nudges, routing alerts, and background-job notices in one shared inbox."
      actions={
        <>
          <Link href="/dashboard" className="button-link secondary">
            Dashboard
          </Link>
          <Link href="/dashboard?tab=cases#case-queue" className="button-link secondary">
            Open Cases
          </Link>
        </>
      }
    >
      <div className="workspace-stack">
        <nav className="workspace-subnav" aria-label="Notification sections">
          <a href="#notification-overview" className="workspace-subnav-link">
            Overview
          </a>
          <a href="#notification-inbox" className="workspace-subnav-link">
            Notification Inbox
          </a>
        </nav>

        {[String(params?.message ?? '').trim(), notificationNotice].filter(Boolean).map((message) => (
          <p key={message} className="notice">
            {message}
          </p>
        ))}

        <section id="notification-overview" className="summary-grid">
          <article className="metric-card">
            <p className="metric-label">Unread</p>
            <p className="metric-value">{unreadNotifications.length}</p>
          </article>
          <article className="metric-card">
            <p className="metric-label">Total</p>
            <p className="metric-value">{notifications.length}</p>
          </article>
          <article className="metric-card">
            <p className="metric-label">Read</p>
            <p className="metric-value">{Math.max(notifications.length - unreadNotifications.length, 0)}</p>
          </article>
          <article className="metric-card">
            <p className="metric-label">Categories</p>
            <p className="metric-value">{categoryCount}</p>
          </article>
        </section>

        <section className="card" id="notification-inbox">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: '0 0 8px 0' }}>Notification Inbox</h2>
              <p style={{ margin: 0, color: '#5e6068' }}>
                Background reminders, payment requests, and calendar jobs write in-app alerts here for every workspace role.
              </p>
            </div>
            {unreadNotifications.length ? (
              <form action={markWorkspaceNotificationRead}>
                <input type="hidden" name="mark_all" value="1" />
                <input type="hidden" name="return_to" value="/notifications#notification-inbox" />
                <button type="submit" className="secondary">
                  Mark All Read
                </button>
              </form>
            ) : null}
          </div>

          {!notifications.length ? (
            <p style={{ margin: '12px 0 0 0', color: '#5e6068' }}>No notifications yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: '12px 0 0 0', padding: 0, display: 'grid', gap: 10 }}>
              {notifications.map((item) => {
                const caseHref = item.case_id
                  ? `/cases/${item.case_id}?return_to=${encodeURIComponent('/notifications#notification-inbox')}`
                  : null

                return (
                  <li
                    key={item.id}
                    style={{
                      border: '1px solid #dbd6c8',
                      borderRadius: 12,
                      padding: 12,
                      background: item.read_at ? 'transparent' : 'rgba(53, 93, 136, 0.06)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                      <div style={{ display: 'grid', gap: 6 }}>
                        <p style={{ margin: 0, fontWeight: 700 }}>{item.title}</p>
                        <p style={{ margin: 0, color: '#5e6068', fontSize: 14 }}>{item.body}</p>
                        <p style={{ margin: 0, color: '#5e6068', fontSize: 13 }}>
                          {new Date(item.created_at).toLocaleString()} | {item.category}
                        </p>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          {item.href ? (
                            <Link href={item.href} className="button-link ghost">
                              Open
                            </Link>
                          ) : null}
                          {caseHref ? (
                            <Link href={caseHref} className="button-link ghost">
                              Open Case
                            </Link>
                          ) : null}
                        </div>
                      </div>
                      {!item.read_at ? (
                        <form action={markWorkspaceNotificationRead}>
                          <input type="hidden" name="notification_id" value={item.id} />
                          <input type="hidden" name="return_to" value="/notifications#notification-inbox" />
                          <button type="submit" className="secondary">
                            Mark Read
                          </button>
                        </form>
                      ) : (
                        <span className="badge">Read</span>
                      )}
                    </div>
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
