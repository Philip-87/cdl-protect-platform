import Link from 'next/link'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { fetchAttorneyCaseOptions, requireAttorneyFeature, requireAttorneyViewer } from '@/app/attorney/lib/server'
import { getAttorneyWorkspaceSummary } from '@/app/attorney/lib/workspace'
import { sendAttorneyCommunication } from '@/app/attorney/tools/actions'

type MessageRow = {
  id: string
  case_id: string
  sender_user_id: string | null
  recipient_role: string | null
  body: string
  created_at: string
}

export default async function AttorneyCommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
  const viewer = await requireAttorneyViewer()
  requireAttorneyFeature(viewer, 'attorney_communications')
  const { supabase, user } = viewer
  const cases = await fetchAttorneyCaseOptions(supabase)
  const profileRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('full_name, email, phone, state, office_address, zip_code, counties, coverage_states, fee_mode, cdl_flat_fee, non_cdl_flat_fee, agreed_to_terms, signature_text, metadata')
    .eq('user_id', user.id)
    .maybeSingle()
  const workspaceSummary = getAttorneyWorkspaceSummary(profileRes.data ?? null)

  const messagesRes = await supabase
    .from('case_messages')
    .select('id, case_id, sender_user_id, recipient_role, body, created_at')
    .order('created_at', { ascending: false })
    .limit(250)

  const messages = (messagesRes.data ?? []) as MessageRow[]
  const caseLinkedCount = new Set(messages.map((item) => item.case_id)).size
  const emailLoggedCount = messages.filter((item) => String(item.recipient_role ?? '').toUpperCase() === 'EMAIL').length

  return (
    <AttorneyWorkspaceLayout
      active="communications"
      title="Communications"
      description="Keep every message, reminder, and email log attached to the correct matter with clear sync visibility and audit-ready thread history."
      actions={
        <>
          <Link href="/attorney/integrations" className="button-link secondary">
            Manage Inbox Sync
          </Link>
          <Link href="/attorney/dashboard#case-queue" className="button-link secondary">
            Open Matter Queue
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#compose" className="workspace-subnav-link active">
            Compose
          </a>
          <a href="#linked-history" className="workspace-subnav-link">
            Linked History
          </a>
          <a href="#needs-review" className="workspace-subnav-link">
            Needs Review
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Inbox Mode</span>
            <strong>{workspaceSummary.emailSyncConnected ? workspaceSummary.emailSyncLabel : 'Manual case log'}</strong>
            <span>{workspaceSummary.emailSyncAddress}</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Linked Messages</span>
            <strong>{messages.length}</strong>
            <span>{caseLinkedCount} matters with history</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Email Logs</span>
            <strong>{emailLoggedCount}</strong>
            <span>Messages marked as email</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Auto-Link Rules</span>
            <strong>Case-centric</strong>
            <span>Sender, recipient, citation, and prior thread context</span>
          </article>
        </>
      }
    >
      {params?.message ? <p className="notice">{params.message}</p> : null}

      <section className="grid-2" id="compose">
        <article className="card attorney-focus-card">
          <div className="section-heading">
            <div>
              <p className="section-eyebrow">Compose</p>
              <h2 className="section-title">Send a case-linked communication</h2>
            </div>
          </div>
          <p className="workspace-toolbar-copy" style={{ marginBottom: 12 }}>
            Compose messages in a matter-centric workflow. External mailbox sync is configured in Integrations; when sync is unavailable, messages are still recorded to the case timeline.
          </p>
          <form action={sendAttorneyCommunication} className="intake-grid">
            <input type="hidden" name="return_to" value="/attorney/communications" />
            <div>
              <label htmlFor="comm-case-id">Matter</label>
              <select id="comm-case-id" name="case_id" required defaultValue="">
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
              <label htmlFor="comm-channel">Channel</label>
              <select id="comm-channel" name="channel" defaultValue="IN_APP">
                <option value="IN_APP">Internal platform message</option>
                <option value="EMAIL">Email log / outbound email</option>
              </select>
            </div>
            <div>
              <label htmlFor="comm-recipient-role">Audience</label>
              <select id="comm-recipient-role" name="recipient_role" defaultValue="">
                <option value="">Unspecified</option>
                <option value="DRIVER">Driver</option>
                <option value="FLEET">Fleet</option>
                <option value="AGENCY">Agency</option>
                <option value="OPS">Ops</option>
              </select>
            </div>
            <div className="full">
              <label htmlFor="comm-subject">Subject</label>
              <input id="comm-subject" name="subject" placeholder="Court date update requested" />
            </div>
            <div className="full">
              <label htmlFor="comm-body">Message</label>
              <textarea id="comm-body" name="body" rows={6} required placeholder="Write your case update, question, or follow-up..." />
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8, flexWrap: 'wrap' }}>
              <button type="submit" className="primary">
                Send and attach to matter
              </button>
              <Link href="/attorney/integrations" className="button-link secondary">
                Sync settings
              </Link>
            </div>
          </form>
        </article>

        <article className="card attorney-focus-card" id="needs-review">
          <div className="section-heading">
            <div>
              <p className="section-eyebrow">Ambiguity Handling</p>
              <h2 className="section-title">Needs review queue</h2>
            </div>
          </div>
          <p className="workspace-toolbar-copy" style={{ marginBottom: 12 }}>
            The platform should auto-link only when confidence is high. When multiple matters match a thread, it should stop and require review instead of guessing silently.
          </p>
          <div className="settings-grid">
            <div className="settings-item">
              <span>Status</span>
              <strong>No ambiguous threads currently flagged</strong>
            </div>
            <div className="settings-item">
              <span>Matching signals</span>
              <strong>Sender, recipients, citation number, case participants, prior thread history</strong>
            </div>
            <div className="settings-item">
              <span>Manual controls</span>
              <strong>Link thread, move to a different matter, or log only one message</strong>
            </div>
            <div className="settings-item">
              <span>Audit trail</span>
              <strong>Show whether a message was linked automatically or manually</strong>
            </div>
          </div>
        </article>
      </section>

      <section className="card" style={{ marginTop: 18 }} id="linked-history">
        <div className="section-heading">
          <div>
            <p className="section-eyebrow">Timeline</p>
            <h2 className="section-title">Recent case communications</h2>
          </div>
        </div>
        {!messages.length ? (
          <p style={{ marginBottom: 0, color: '#5e6068' }}>No communication history found.</p>
        ) : (
          <ul className="attorney-feed-list attorney-feed-list-large">
            {messages.map((item) => (
              <li key={item.id}>
                <Link href={`/cases/${item.case_id}?return_to=${encodeURIComponent('/attorney/communications')}`}>
                  Case {item.case_id}
                </Link>
                <span>
                  From {item.sender_user_id || 'System'} · To {item.recipient_role || 'N/A'} · {new Date(item.created_at).toLocaleString()}
                </span>
                <p style={{ margin: '8px 0 0 0', whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{item.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AttorneyWorkspaceLayout>
  )
}
