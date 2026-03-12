import Link from 'next/link'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { requireAttorneyViewer } from '@/app/attorney/lib/server'
import { getAttorneyWorkspaceSummary } from '@/app/attorney/lib/workspace'

export default async function AttorneySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
  const { supabase, user, role, displayEmail } = await requireAttorneyViewer()

  const profileRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('full_name, email, phone, state, office_address, zip_code, counties, coverage_states, fee_mode, cdl_flat_fee, non_cdl_flat_fee, agreed_to_terms, signature_text, metadata')
    .eq('user_id', user.id)
    .maybeSingle()

  const workspaceSummary = getAttorneyWorkspaceSummary(profileRes.data ?? null)

  return (
    <AttorneyWorkspaceLayout
      active="settings"
      title="Settings"
      description="Control account context, routing readiness, and operational defaults for the attorney workspace."
      actions={
        <>
          <Link href="/attorney/my-firm" className="button-link secondary">
            Profile
          </Link>
          <Link href="/attorney/integrations" className="button-link secondary">
            Integrations
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#account" className="workspace-subnav-link active">
            Account
          </a>
          <a href="#routing-defaults" className="workspace-subnav-link">
            Routing Defaults
          </a>
          <a href="#system-links" className="workspace-subnav-link">
            System Links
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Account</span>
            <strong>{displayEmail || user.email || 'Attorney user'}</strong>
            <span>{role}</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Profile Completion</span>
            <strong>{workspaceSummary.profileCompletion}%</strong>
            <span>Routing readiness score</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Coverage</span>
            <strong>{workspaceSummary.coverageStateCount} states</strong>
            <span>{workspaceSummary.countyCount} counties</span>
          </article>
        </>
      }
    >
      {params?.message ? <p className="notice">{params.message}</p> : null}

      <section className="settings-grid" id="account">
        <article className="settings-item">
          <span>Primary Email</span>
          <strong>{displayEmail || user.email || 'Not available'}</strong>
        </article>
        <article className="settings-item">
          <span>Theme + Workspace</span>
          <strong>Use the global header theme toggle and attorney sidebar for navigation.</strong>
        </article>
        <article className="settings-item">
          <span>Notification Model</span>
          <strong>Unread communications, overdue reminders, and hearing conflicts surface across dashboard cards.</strong>
        </article>
        <article className="settings-item">
          <span>Security</span>
          <strong>Password resets and account-level authentication stay managed through platform auth.</strong>
        </article>
      </section>

      <section className="card" style={{ marginTop: 18 }} id="routing-defaults">
        <div className="section-heading">
          <div>
            <p className="section-eyebrow">Routing Defaults</p>
            <h2 className="section-title">Operational controls that affect daily case handling</h2>
          </div>
        </div>
        <div className="settings-grid">
          <div className="settings-item">
            <span>Inbox Sync</span>
            <strong>{workspaceSummary.emailSyncConnected ? workspaceSummary.emailSyncAddress : 'Manual case-linked messaging'}</strong>
          </div>
          <div className="settings-item">
            <span>Calendar Sync</span>
            <strong>{workspaceSummary.calendarSyncConnected ? workspaceSummary.calendarSyncAddress : 'Manual docket calendar'}</strong>
          </div>
          <div className="settings-item">
            <span>Fee Logic</span>
            <strong>{workspaceSummary.feeMode === 'BY_COUNTY' ? 'County fee overrides enabled' : 'Global fee mode enabled'}</strong>
          </div>
          <div className="settings-item">
            <span>Billing Connection</span>
            <strong>{workspaceSummary.lawpayConnected ? 'Merchant credentials saved' : 'Billing provider not connected'}</strong>
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 18 }} id="system-links">
        <div className="section-heading">
          <div>
            <p className="section-eyebrow">System Links</p>
            <h2 className="section-title">Manage related attorney workspace areas</h2>
          </div>
        </div>
        <div className="workspace-toolbar-actions">
          <Link href="/attorney/my-firm" className="button-link secondary">
            My Firm
          </Link>
          <Link href="/attorney/coverage-fees" className="button-link secondary">
            Coverage & Fees
          </Link>
          <Link href="/attorney/integrations" className="button-link secondary">
            Integrations
          </Link>
          <Link href="/attorney/billing" className="button-link secondary">
            Billing
          </Link>
          <Link href="/attorney/onboarding" className="button-link secondary">
            Onboarding
          </Link>
        </div>
      </section>
    </AttorneyWorkspaceLayout>
  )
}
