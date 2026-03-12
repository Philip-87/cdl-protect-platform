export type AttorneyWorkspaceProfile = {
  full_name?: string | null
  email?: string | null
  phone?: string | null
  state?: string | null
  office_address?: string | null
  city?: string | null
  zip_code?: string | null
  counties?: unknown
  coverage_states?: unknown
  fee_mode?: string | null
  cdl_flat_fee?: number | null
  non_cdl_flat_fee?: number | null
  agreed_to_terms?: boolean | null
  signature_text?: string | null
  metadata?: Record<string, unknown> | null
}

function normalizeStringArray(raw: unknown) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean)
  }

  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(/[;,|]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return [] as string[]
}

function getIntegrationRecord(profile: AttorneyWorkspaceProfile) {
  const raw = profile.metadata?.['integrations']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

export function getAttorneyWorkspaceSummary(profile: AttorneyWorkspaceProfile | null | undefined) {
  const source = profile ?? {}
  const coverageStates = normalizeStringArray(source.coverage_states)
  const counties = normalizeStringArray(source.counties)
  const integrations = getIntegrationRecord(source)
  const emailProvider = String(integrations['email_provider'] ?? '').trim()
  const emailAddress = String(integrations['email_address'] ?? '').trim()
  const calendarEnabled = Boolean(integrations['google_calendar_enabled'])
  const calendarEmail = String(integrations['google_calendar_email'] ?? '').trim()
  const lawpayConnected = Boolean(String(integrations['lawpay_merchant_id'] ?? '').trim())
  const feeMode = String(source.fee_mode ?? '').trim().toUpperCase() || 'GLOBAL'

  const completionChecks = [
    Boolean(String(source.full_name ?? '').trim()),
    Boolean(String(source.email ?? '').trim()),
    Boolean(String(source.phone ?? '').trim()),
    Boolean(String(source.state ?? '').trim()),
    Boolean(String(source.office_address ?? '').trim()),
    Boolean(String(source.zip_code ?? '').trim()),
    coverageStates.length > 0,
    counties.length > 0,
    Boolean(source.agreed_to_terms),
    Boolean(String(source.signature_text ?? '').trim()),
    feeMode === 'BY_COUNTY'
      ? counties.length > 0
      : Number.isFinite(Number(source.cdl_flat_fee ?? 0)) && Number(source.cdl_flat_fee ?? 0) > 0,
  ]

  const profileCompletion = Math.round(
    (completionChecks.filter(Boolean).length / Math.max(1, completionChecks.length)) * 100
  )

  return {
    profileCompletion,
    coverageStateCount: coverageStates.length,
    countyCount: counties.length,
    feeMode,
    emailSyncConnected: Boolean(emailProvider && emailAddress),
    emailSyncLabel: emailProvider || 'Manual',
    emailSyncAddress: emailAddress || 'No synced inbox',
    calendarSyncConnected: calendarEnabled && Boolean(calendarEmail),
    calendarSyncAddress: calendarEmail || 'No linked calendar',
    lawpayConnected,
    counties,
    coverageStates,
  }
}

export function summarizeReminderRisk(overdueCount: number, dueSoonCount: number) {
  if (overdueCount > 0) return `${overdueCount} overdue`
  if (dueSoonCount > 0) return `${dueSoonCount} due this week`
  return 'On track'
}
