import Link from 'next/link'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { requireAttorneyViewer } from '@/app/attorney/lib/server'
import { getAttorneyWorkspaceSummary } from '@/app/attorney/lib/workspace'
import { getCalendarIntegrationOverview } from '@/app/lib/server/calendar-sync'
import { hasPlatformFeature } from '@/app/lib/server/role-features'
import {
  disconnectAttorneyCalendarConnection,
  runAttorneyCalendarSync,
  saveAttorneyIntegrations,
} from '@/app/attorney/tools/actions'

export default async function AttorneyIntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
  const viewer = await requireAttorneyViewer()
  const { supabase, user, enabledFeatures } = viewer
  const calendarSyncEnabled = hasPlatformFeature(enabledFeatures, 'attorney_calendar_sync')

  const profileRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('metadata')
    .eq('user_id', user.id)
    .maybeSingle<{ metadata: Record<string, unknown> | null }>()

  const metadata = profileRes.data?.metadata ?? {}
  const integrationsRaw = metadata['integrations']
  const integrations =
    integrationsRaw && typeof integrationsRaw === 'object' && !Array.isArray(integrationsRaw)
      ? (integrationsRaw as Record<string, unknown>)
      : {}

  const emailProvider = String(integrations['email_provider'] ?? '')
  const emailAddress = String(integrations['email_address'] ?? '')
  const emailConnectedAt = String(integrations['email_connected_at'] ?? '')
  const lawpayMerchantId = String(integrations['lawpay_merchant_id'] ?? '')
  const lawpayConnectedAt = String(integrations['lawpay_connected_at'] ?? '')
  const googleCalendarEmail = String(integrations['google_calendar_email'] ?? '')
  const googleCalendarEnabled = Boolean(integrations['google_calendar_enabled'])
  const googleCalendarConnectedAt = String(integrations['google_calendar_connected_at'] ?? '')
  const workspaceSummary = getAttorneyWorkspaceSummary({
    metadata,
  })
  const calendarOverview = await getCalendarIntegrationOverview(supabase, user.id)
  const providerRows = [
    { key: 'GOOGLE' as const, label: 'Google Calendar', connectHref: '/api/integrations/google-calendar/connect?return_to=/attorney/integrations' },
    { key: 'MICROSOFT' as const, label: 'Microsoft 365 Calendar', connectHref: '/api/integrations/microsoft-calendar/connect?return_to=/attorney/integrations' },
  ]
  const providerByKey = new Map(calendarOverview.integrations.map((row) => [row.provider, row]))
  const integrationNotice = calendarOverview.missing
    ? 'Apply the calendar sync + notifications migration to connect Google or Microsoft calendars.'
    : calendarOverview.error
      ? `Calendar integration status is unavailable: ${calendarOverview.error}`
      : ''

  return (
    <AttorneyWorkspaceLayout
      active="integrations"
      title="Integrations"
      description="Connect the systems that power attorney operations: inbox sync, billing, and calendar visibility for court appearances and follow-up work."
      actions={
        <>
          <Link href="/attorney/calendar" className="button-link secondary">
            Open calendar
          </Link>
          <Link href="/attorney/communications" className="button-link secondary">
            Communications
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#connectors" className="workspace-subnav-link active">
            Connectors
          </a>
          <a href="#statuses" className="workspace-subnav-link">
            Status
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Email</span>
            <strong>{workspaceSummary.emailSyncConnected ? workspaceSummary.emailSyncLabel : 'Not connected'}</strong>
            <span>{workspaceSummary.emailSyncAddress}</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Calendar</span>
            <strong>{calendarOverview.preferred ? `${calendarOverview.preferred.provider} connected` : 'Not connected'}</strong>
            <span>{calendarOverview.preferred?.provider_account_email || workspaceSummary.calendarSyncAddress}</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Billing</span>
            <strong>{lawpayMerchantId ? 'Merchant saved' : 'Not connected'}</strong>
            <span>{lawpayMerchantId || 'LawPay not configured'}</span>
          </article>
        </>
      }
    >
        {[String(params?.message ?? '').trim(), integrationNotice, !calendarSyncEnabled ? 'Calendar sync is disabled for your role.' : '']
          .filter(Boolean)
          .map((message) => (
          <p key={message} className="notice">
            {message}
          </p>
        ))}

        {calendarSyncEnabled ? (
        <section className="grid-2" style={{ marginTop: 0 }} id="connectors">
          {providerRows.map((provider) => {
            const row = providerByKey.get(provider.key)
            const connected = Boolean(row)

            return (
              <article key={provider.key} className="card">
                <h2 style={{ margin: '0 0 8px 0' }}>{provider.label}</h2>
                <p style={{ margin: 0, color: '#5e6068', fontSize: 14 }}>
                  Connect the attorney workspace to sync case-linked events, import external commitments, and avoid duplicate scheduling.
                </p>
                <div style={{ display: 'grid', gap: 6, marginTop: 12, fontSize: 14 }}>
                  <p style={{ margin: 0 }}>
                    <strong>Status:</strong> {row?.last_sync_status || 'Not connected'}
                  </p>
                  <p style={{ margin: 0 }}>
                    <strong>Account:</strong> {row?.provider_account_email || 'Not connected'}
                  </p>
                  <p style={{ margin: 0 }}>
                    <strong>Direction:</strong> {row?.sync_direction || 'BIDIRECTIONAL'}
                  </p>
                  <p style={{ margin: 0 }}>
                    <strong>Last sync:</strong>{' '}
                    {row?.last_sync_at ? new Date(row.last_sync_at).toLocaleString() : 'No sync run yet'}
                  </p>
                  {row?.last_sync_error ? (
                    <p className="error" style={{ margin: 0 }}>
                      Latest error: {row.last_sync_error}
                    </p>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
                  {connected ? (
                      <>
                        <form action={runAttorneyCalendarSync}>
                        <input type="hidden" name="integration_id" value={row?.id ?? ''} />
                        <input type="hidden" name="return_to" value="/attorney/integrations" />
                        <button type="submit" className="primary">
                          Sync Now
                        </button>
                      </form>
                      <form action={disconnectAttorneyCalendarConnection}>
                        <input type="hidden" name="integration_id" value={row?.id ?? ''} />
                        <input type="hidden" name="provider" value={provider.key} />
                        <input type="hidden" name="return_to" value="/attorney/integrations" />
                        <button type="submit" className="secondary">
                          Disconnect
                        </button>
                      </form>
                    </>
                  ) : (
                    <Link href={provider.connectHref} className="button-link primary">
                      Connect
                    </Link>
                  )}
                  <Link href="/attorney/calendar" className="button-link ghost">
                    Open Calendar
                  </Link>
                </div>
              </article>
            )
          })}
        </section>
        ) : null}

        <section className="card" style={{ marginTop: 14 }}>
          <h2 style={{ margin: '0 0 8px 0' }}>Email and Billing Metadata</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Save inbox and LawPay reference details so communications and billing ownership stay visible inside the matter workflow.
          </p>
          <form action={saveAttorneyIntegrations} className="intake-grid">
            <input type="hidden" name="return_to" value="/attorney/integrations" />
            <div>
              <label htmlFor="integration-email-provider">Email Provider</label>
              <select id="integration-email-provider" name="email_provider" defaultValue={emailProvider || ''}>
                <option value="">Not connected</option>
                <option value="GOOGLE_WORKSPACE">Google Workspace</option>
                <option value="MICROSOFT_365">Microsoft 365</option>
                <option value="IMAP_SMTP">IMAP / SMTP</option>
              </select>
            </div>
            <div>
              <label htmlFor="integration-email-address">Email Address</label>
              <input
                id="integration-email-address"
                name="email_address"
                type="email"
                defaultValue={emailAddress || ''}
                placeholder="attorney@firm.com"
              />
            </div>
            <div>
              <label htmlFor="integration-lawpay-id">LawPay Merchant ID</label>
              <input
                id="integration-lawpay-id"
                name="lawpay_merchant_id"
                defaultValue={lawpayMerchantId || ''}
                placeholder="lp_merchant_..."
              />
            </div>
            <div>
              <label htmlFor="integration-google-calendar-email">Calendar Email (fallback metadata)</label>
              <input
                id="integration-google-calendar-email"
                name="google_calendar_email"
                type="email"
                defaultValue={googleCalendarEmail || ''}
                placeholder="calendar@firm.com"
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="integration-google-calendar-enabled"
                name="google_calendar_enabled"
                type="checkbox"
                value="1"
                defaultChecked={googleCalendarEnabled}
                style={{ width: 'auto' }}
              />
              <label htmlFor="integration-google-calendar-enabled" style={{ margin: 0 }}>
                Keep legacy Google Calendar metadata enabled
              </label>
            </div>
            <div style={{ display: 'flex', alignItems: 'end' }}>
              <button type="submit" className="primary">
                Save Integrations
              </button>
            </div>
          </form>
        </section>

        <section className="grid-2" style={{ marginTop: 14 }} id="statuses">
          <article className="card">
            <h2 style={{ margin: '0 0 8px 0' }}>Email Connection</h2>
            <p style={{ margin: 0 }}>
              <strong>Provider:</strong> {emailProvider || 'Not connected'}
            </p>
            <p style={{ marginTop: 6 }}>
              <strong>Address:</strong> {emailAddress || 'Not set'}
            </p>
            <p style={{ marginTop: 6, color: '#5e6068' }}>
              {emailConnectedAt ? `Connected at ${new Date(emailConnectedAt).toLocaleString()}` : 'No connection timestamp.'}
            </p>
          </article>
          <article className="card">
            <h2 style={{ margin: '0 0 8px 0' }}>LawPay Connection</h2>
            <p style={{ margin: 0 }}>
              <strong>Merchant ID:</strong> {lawpayMerchantId || 'Not connected'}
            </p>
            <p style={{ marginTop: 6, color: '#5e6068' }}>
              {lawpayConnectedAt ? `Connected at ${new Date(lawpayConnectedAt).toLocaleString()}` : 'No connection timestamp.'}
            </p>
            <p style={{ marginTop: 10, color: '#5e6068', fontSize: 14 }}>
              This stores connection metadata. Full provider OAuth sync can be layered next.
            </p>
          </article>
          <article className="card">
            <h2 style={{ margin: '0 0 8px 0' }}>Google Calendar</h2>
            <p style={{ margin: 0 }}>
              <strong>Status:</strong> {providerByKey.get('GOOGLE')?.last_sync_status || (googleCalendarEnabled ? 'Legacy metadata only' : 'Not connected')}
            </p>
            <p style={{ marginTop: 6 }}>
              <strong>Calendar Email:</strong> {providerByKey.get('GOOGLE')?.provider_account_email || googleCalendarEmail || 'Not set'}
            </p>
            <p style={{ marginTop: 6, color: '#5e6068' }}>
              {(providerByKey.get('GOOGLE')?.last_sync_at || googleCalendarConnectedAt)
                ? `Connected at ${new Date(providerByKey.get('GOOGLE')?.last_sync_at || googleCalendarConnectedAt).toLocaleString()}`
                : 'No connection timestamp.'}
            </p>
            <p style={{ marginTop: 10, color: '#5e6068', fontSize: 14 }}>
              Google OAuth, import/export, and sync state are now handled from the provider cards above.
            </p>
            <div style={{ marginTop: 10 }}>
              <Link href="/attorney/calendar" className="button-link secondary">
                Open Calendar
              </Link>
            </div>
          </article>
        </section>
    </AttorneyWorkspaceLayout>
  )
}
