import Link from 'next/link'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { fetchAttorneyCaseOptions, requireAttorneyFeature, requireAttorneyViewer } from '@/app/attorney/lib/server'
import { completeAttorneyTask, createAttorneyReminder, markAttorneyNotificationRead } from '@/app/attorney/tools/actions'

type ReminderRow = {
  id: string
  case_id: string
  instructions: string | null
  status: string
  due_at: string | null
  created_at: string
}

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

export default async function AttorneyRemindersPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
  const viewer = await requireAttorneyViewer()
  requireAttorneyFeature(viewer, 'attorney_reminders')
  const { supabase } = viewer
  const cases = await fetchAttorneyCaseOptions(supabase)

  const remindersRes = await supabase
    .from('case_tasks')
    .select('id, case_id, instructions, status, due_at, created_at')
    .eq('target_role', 'ATTORNEY')
    .eq('task_type', 'ATTORNEY_REMINDER')
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(250)
  const reminders = (remindersRes.data ?? []) as ReminderRow[]
  const overdueReminders = reminders.filter((item) => item.status !== 'DONE' && item.due_at && new Date(item.due_at) < new Date())
  const notificationsRes = await supabase
    .from('in_app_notifications')
    .select('id, case_id, category, title, body, href, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(50)
  const notifications =
    notificationsRes.error && /does not exist|schema cache/i.test(notificationsRes.error.message)
      ? ([] as NotificationRow[])
      : ((notificationsRes.data ?? []) as NotificationRow[])
  const notificationNotice =
    notificationsRes.error && /does not exist|schema cache/i.test(notificationsRes.error.message)
      ? 'Apply the calendar sync + notifications migration to unlock the reminder inbox.'
      : notificationsRes.error
        ? `Notifications are unavailable: ${notificationsRes.error.message}`
        : ''
  const unreadNotifications = notifications.filter((item) => !item.read_at)

  return (
    <AttorneyWorkspaceLayout
      active="reminders"
      title="Reminders"
      description="Track court preparation, follow-ups, document requests, and deadline nudges across all active matters."
      actions={
        <>
          <Link href="/attorney/calendar" className="button-link secondary">
            Calendar
          </Link>
          <Link href="/attorney/tasks" className="button-link secondary">
            Tasks
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#new-reminder" className="workspace-subnav-link active">
            Add Reminder
          </a>
          <a href="#notification-inbox" className="workspace-subnav-link">
            Notification Inbox
          </a>
          <a href="#upcoming-reminders" className="workspace-subnav-link">
            Upcoming
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Upcoming</span>
            <strong>{reminders.filter((item) => item.status !== 'DONE').length}</strong>
            <span>Open reminder records</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Overdue</span>
            <strong>{overdueReminders.length}</strong>
            <span>Needs immediate follow-up</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Completed</span>
            <strong>{reminders.filter((item) => item.status === 'DONE').length}</strong>
            <span>Reminder history</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Notifications</span>
            <strong>{unreadNotifications.length}</strong>
            <span>{unreadNotifications.length ? 'Unread reminder deliveries' : 'Inbox clear'}</span>
          </article>
        </>
      }
    >
        {[String(params?.message ?? '').trim(), notificationNotice].filter(Boolean).map((message) => (
          <p key={message} className="notice">
            {message}
          </p>
        ))}

        <section className="card" id="new-reminder">
          <h2 style={{ margin: '0 0 8px 0' }}>Add Reminder</h2>
          <form action={createAttorneyReminder} className="intake-grid">
            <input type="hidden" name="return_to" value="/attorney/reminders" />
            <div>
              <label htmlFor="reminder-case-id">Case</label>
              <select id="reminder-case-id" name="case_id" required defaultValue="">
                <option value="" disabled>
                  Select case
                </option>
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} | {c.state} | {c.citation_number ?? '-'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="reminder-text">Reminder Text</label>
              <input id="reminder-text" name="reminder_text" required placeholder="Follow up with court clerk" />
            </div>
            <div>
              <label htmlFor="reminder-date">Remind On</label>
              <input id="reminder-date" name="remind_on" type="date" required />
            </div>
            <div style={{ display: 'flex', alignItems: 'end' }}>
              <button type="submit" className="primary">
                Save Reminder
              </button>
            </div>
          </form>
        </section>

        <section className="card" style={{ marginTop: 14 }} id="notification-inbox">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div>
              <h2 style={{ margin: '0 0 8px 0' }}>Notification Inbox</h2>
              <p style={{ margin: 0, color: '#5e6068' }}>
                Background reminder delivery writes in-app alerts here and can also send email notifications.
              </p>
            </div>
            {unreadNotifications.length ? (
              <form action={markAttorneyNotificationRead}>
                <input type="hidden" name="mark_all" value="1" />
                <input type="hidden" name="return_to" value="/attorney/reminders#notification-inbox" />
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
              {notifications.map((item) => (
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
                        {item.case_id ? (
                          <Link
                            href={`/cases/${item.case_id}?return_to=${encodeURIComponent('/attorney/reminders#notification-inbox')}`}
                            className="button-link ghost"
                          >
                            Open Case
                          </Link>
                        ) : null}
                      </div>
                    </div>
                    {!item.read_at ? (
                      <form action={markAttorneyNotificationRead}>
                        <input type="hidden" name="notification_id" value={item.id} />
                        <input type="hidden" name="return_to" value="/attorney/reminders#notification-inbox" />
                        <button type="submit" className="secondary">
                          Mark Read
                        </button>
                      </form>
                    ) : (
                      <span className="badge">Read</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" style={{ marginTop: 14 }} id="upcoming-reminders">
          <h2 style={{ margin: '0 0 8px 0' }}>Upcoming Reminders</h2>
          {!reminders.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No reminders yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {reminders.map((item) => (
                <li key={item.id} style={{ border: '1px solid #dbd6c8', borderRadius: 10, padding: 10 }}>
                  <p style={{ margin: 0, fontWeight: 700 }}>{item.instructions || 'Reminder'}</p>
                  <p style={{ margin: '4px 0 0 0', color: '#5e6068', fontSize: 14 }}>
                    Case: <Link href={`/cases/${item.case_id}?return_to=${encodeURIComponent('/attorney/reminders')}`}>{item.case_id}</Link> | Due:{' '}
                    {item.due_at ? new Date(item.due_at).toLocaleString() : '-'} | Status: {item.status}
                  </p>
                  {item.status !== 'DONE' ? (
                    <form action={completeAttorneyTask} style={{ marginTop: 8 }}>
                      <input type="hidden" name="task_id" value={item.id} />
                      <input type="hidden" name="case_id" value={item.case_id} />
                      <input type="hidden" name="return_to" value="/attorney/reminders" />
                      <button type="submit" className="secondary">
                        Mark Complete
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
    </AttorneyWorkspaceLayout>
  )
}
