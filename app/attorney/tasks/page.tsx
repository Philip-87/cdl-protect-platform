import Link from 'next/link'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { fetchAttorneyCaseOptions, requireAttorneyFeature, requireAttorneyViewer } from '@/app/attorney/lib/server'
import { completeAttorneyTask, createAttorneyTask } from '@/app/attorney/tools/actions'

type TaskRow = {
  id: string
  case_id: string
  task_type: string
  instructions: string | null
  status: string
  due_at: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export default async function AttorneyTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
  const viewer = await requireAttorneyViewer()
  requireAttorneyFeature(viewer, 'attorney_tasks')
  const { supabase } = viewer
  const cases = await fetchAttorneyCaseOptions(supabase)

  const tasksRes = await supabase
    .from('case_tasks')
    .select('id, case_id, task_type, instructions, status, due_at, metadata, created_at')
    .eq('target_role', 'ATTORNEY')
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(300)

  const tasks = (tasksRes.data ?? []) as TaskRow[]
  const openTasks = tasks.filter((task) => task.status === 'OPEN' || task.status === 'PENDING')
  const doneTasks = tasks.filter((task) => task.status === 'DONE')
  const overdueTasks = openTasks.filter((task) => task.due_at && new Date(task.due_at) < new Date())

  return (
    <AttorneyWorkspaceLayout
      active="tasks"
      title="Tasks"
      description="Run the attorney work queue by matter, with quick access to deadlines, preparation tasks, and follow-ups."
      actions={
        <>
          <Link href="/attorney/reminders" className="button-link secondary">
            Reminders
          </Link>
          <Link href="/attorney/dashboard#case-queue" className="button-link secondary">
            Matter queue
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#new-task" className="workspace-subnav-link active">
            New Task
          </a>
          <a href="#open-tasks" className="workspace-subnav-link">
            Open
          </a>
          <a href="#completed-tasks" className="workspace-subnav-link">
            Completed
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Open Tasks</span>
            <strong>{openTasks.length}</strong>
            <span>Attorney-targeted work items</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Overdue</span>
            <strong>{overdueTasks.length}</strong>
            <span>Needs immediate attention</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Completed</span>
            <strong>{doneTasks.length}</strong>
            <span>Closed task records</span>
          </article>
        </>
      }
    >
        {params?.message ? <p className="notice">{params.message}</p> : null}

        <section className="card" id="new-task">
          <h2 style={{ margin: '0 0 8px 0' }}>Create Task</h2>
          <form action={createAttorneyTask} className="intake-grid">
            <input type="hidden" name="return_to" value="/attorney/tasks" />
            <div>
              <label htmlFor="task-case-id">Case</label>
              <select id="task-case-id" name="case_id" required defaultValue="">
                <option value="" disabled>
                  Select case
                </option>
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} | {c.state} | {c.county ?? '-'} | {c.citation_number ?? '-'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="task-title">Task Name</label>
              <input id="task-title" name="title" placeholder="Prepare discovery packet" required />
            </div>
            <div>
              <label htmlFor="task-priority">Priority</label>
              <select id="task-priority" name="priority" defaultValue="MEDIUM">
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </select>
            </div>
            <div>
              <label htmlFor="task-due">Due Date</label>
              <input id="task-due" name="due_at" type="date" />
            </div>
            <div style={{ display: 'flex', alignItems: 'end' }}>
              <button type="submit" className="primary">
                Add Task
              </button>
            </div>
          </form>
        </section>

        <section className="card" style={{ marginTop: 14 }} id="open-tasks">
          <h2 style={{ margin: '0 0 8px 0' }}>Open Tasks ({openTasks.length})</h2>
          {!openTasks.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No open tasks.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #dbd6c8', textAlign: 'left' }}>
                    <th style={{ padding: '10px 8px' }}>Action</th>
                    <th style={{ padding: '10px 8px' }}>Task</th>
                    <th style={{ padding: '10px 8px' }}>Case</th>
                    <th style={{ padding: '10px 8px' }}>Due</th>
                    <th style={{ padding: '10px 8px' }}>Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {openTasks.map((task) => (
                    <tr key={task.id} style={{ borderBottom: '1px solid #efe8d9' }}>
                      <td style={{ padding: '8px' }}>
                        <form action={completeAttorneyTask}>
                          <input type="hidden" name="task_id" value={task.id} />
                          <input type="hidden" name="case_id" value={task.case_id} />
                          <input type="hidden" name="return_to" value="/attorney/tasks" />
                          <button type="submit" className="secondary">
                            Mark Done
                          </button>
                        </form>
                      </td>
                      <td style={{ padding: '8px' }}>{task.instructions || task.task_type}</td>
                      <td style={{ padding: '8px' }}>
                        <Link href={`/cases/${task.case_id}?return_to=${encodeURIComponent('/attorney/tasks')}`}>{task.case_id}</Link>
                      </td>
                      <td style={{ padding: '8px' }}>{task.due_at ? new Date(task.due_at).toLocaleString() : '-'}</td>
                      <td style={{ padding: '8px' }}>{String(task.metadata?.['priority'] ?? '-')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" style={{ marginTop: 14 }} id="completed-tasks">
          <h2 style={{ margin: '0 0 8px 0' }}>Completed Tasks ({doneTasks.length})</h2>
          {!doneTasks.length ? (
            <p style={{ marginBottom: 0, color: '#5e6068' }}>No completed tasks yet.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, color: '#5e6068', display: 'grid', gap: 6 }}>
              {doneTasks.slice(0, 12).map((task) => (
                <li key={task.id}>
                  {task.instructions || task.task_type} | {task.case_id}
                </li>
              ))}
            </ul>
          )}
        </section>
    </AttorneyWorkspaceLayout>
  )
}
