import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { getAttorneyWorkspaceSummary } from '@/app/attorney/lib/workspace'
import { createClient } from '@/app/lib/supabase/server'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { isMapsApiKeyConfigured } from '@/app/lib/server/maps'
import MyFirmEditor from './MyFirmEditor'

type OnboardingProfileRow = {
  full_name: string | null
  email: string | null
  phone: string | null
  state: string | null
  office_address: string | null
  city: string | null
  zip_code: string | null
  counties: unknown
  coverage_states: unknown
  primary_county: string | null
  agreed_to_terms: boolean | null
  signature_text: string | null
  metadata: Record<string, unknown> | null
}

type CountyReferenceRow = {
  state_code: string
  county_name: string
}

type CaseCountyRow = {
  state: string
  county: string | null
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

export default async function AttorneyMyFirmPage({
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
    redirect('/attorney/login?redirectedFrom=/attorney/my-firm&message=Please%20sign%20in.')
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
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/dashboard?message=Attorney%20portal%20requires%20an%20attorney%20or%20admin%20role.')
  }

  const onboardingRes = await supabase
    .from('attorney_onboarding_profiles')
    .select(
      'full_name, email, phone, state, office_address, city, zip_code, counties, coverage_states, primary_county, agreed_to_terms, signature_text, metadata'
    )
    .eq('user_id', user.id)
    .maybeSingle<OnboardingProfileRow>()
  const onboarding = onboardingRes.data

  if (!onboarding || !onboarding.agreed_to_terms || !String(onboarding.signature_text ?? '').trim()) {
    redirect('/attorney/onboarding?message=Complete%20onboarding%20before%20opening%20My%20Firm.')
  }

  const [countyReferenceRes, caseCountyRes] = await Promise.all([
    supabase
      .from('county_reference')
      .select('state_code, county_name')
      .order('state_code', { ascending: true })
      .limit(12000),
    supabase.from('cases').select('state, county').not('county', 'is', null).limit(3000),
  ])

  const countiesByState: Record<string, string[]> = {}
  for (const row of (countyReferenceRes.data ?? []) as CountyReferenceRow[]) {
    const state = String(row.state_code ?? '').trim().toUpperCase()
    const county = String(row.county_name ?? '').trim()
    if (!state || !county) continue
    if (!countiesByState[state]) countiesByState[state] = []
    if (!countiesByState[state].includes(county)) countiesByState[state].push(county)
  }

  for (const row of (caseCountyRes.data ?? []) as CaseCountyRow[]) {
    const state = String(row.state ?? '').trim().toUpperCase()
    const county = String(row.county ?? '').trim()
    if (!state || !county) continue
    if (!countiesByState[state]) countiesByState[state] = []
    if (!countiesByState[state].includes(county)) countiesByState[state].push(county)
  }

  Object.keys(countiesByState).forEach((state) => {
    countiesByState[state].sort((a, b) => a.localeCompare(b))
  })

  const metadataCoverageStates = normalizeStringArray(onboarding.metadata?.['coverage_states'])
  const initial = {
    fullName: onboarding.full_name ?? profileByUserId?.full_name ?? '',
    email: onboarding.email ?? profileByUserId?.email ?? user.email ?? '',
    phone: onboarding.phone ?? '',
    state: onboarding.state ?? '',
    officeAddress: onboarding.office_address ?? '',
    city: onboarding.city ?? '',
    zipCode: onboarding.zip_code ?? '',
    coverageStates:
      normalizeStringArray(onboarding.coverage_states).length > 0
        ? normalizeStringArray(onboarding.coverage_states)
        : metadataCoverageStates.length > 0
        ? metadataCoverageStates
        : onboarding.state
        ? [onboarding.state]
        : [],
    counties: normalizeStringArray(onboarding.counties),
    primaryCounty: onboarding.primary_county ?? String(onboarding.metadata?.['primary_county'] ?? ''),
  }
  const mapsEnabled = isMapsApiKeyConfigured()
  const workspaceSummary = getAttorneyWorkspaceSummary(onboarding)

  return (
    <AttorneyWorkspaceLayout
      active="my-firm"
      title="My Firm / Profile"
      description="Keep firm identity, jurisdiction coverage, and routing readiness current so new traffic matters reach the right attorney with the right fee logic."
      actions={
        <>
          <Link href="/attorney/coverage-fees" className="button-link secondary">
            Coverage & Fees
          </Link>
          <Link href="/attorney/integrations" className="button-link secondary">
            Integrations
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#firm-overview" className="workspace-subnav-link active">
            Overview
          </a>
          <a href="#firm-editor" className="workspace-subnav-link">
            Firm details
          </a>
          <a href="#routing-readiness" className="workspace-subnav-link">
            Routing readiness
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Profile Completion</span>
            <strong>{workspaceSummary.profileCompletion}%</strong>
            <span>Attorney routing profile</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Coverage</span>
            <strong>{workspaceSummary.coverageStateCount} states</strong>
            <span>{workspaceSummary.countyCount} counties</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Inbox Sync</span>
            <strong>{workspaceSummary.emailSyncConnected ? workspaceSummary.emailSyncLabel : 'Manual mode'}</strong>
            <span>{workspaceSummary.emailSyncAddress}</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Calendar Sync</span>
            <strong>{workspaceSummary.calendarSyncConnected ? 'Connected' : 'Not connected'}</strong>
            <span>{workspaceSummary.calendarSyncAddress}</span>
          </article>
        </>
      }
    >
      <section className="settings-grid" id="firm-overview">
        <article className="settings-item">
          <span>Attorney</span>
          <strong>{initial.fullName || 'Not set'}</strong>
        </article>
        <article className="settings-item">
          <span>Office</span>
          <strong>{initial.officeAddress || 'Not set'}</strong>
        </article>
        <article className="settings-item">
          <span>Coverage</span>
          <strong>{initial.coverageStates.length} states · {initial.counties.length} counties</strong>
        </article>
        <article className="settings-item">
          <span>Maps</span>
          <strong>{mapsEnabled ? 'Address validation available' : 'Maps API not configured'}</strong>
        </article>
      </section>

      <section className="card" style={{ marginTop: 18 }} id="routing-readiness">
        <div className="section-heading">
          <div>
            <p className="section-eyebrow">Routing Readiness</p>
            <h2 className="section-title">Keep profile, pricing, and integrations aligned</h2>
          </div>
        </div>
        <div className="settings-grid">
          <div className="settings-item">
            <span>Coverage & Fees</span>
            <strong>Confirm fee mode and county overrides before enabling automatic routing.</strong>
          </div>
          <div className="settings-item">
            <span>Integrations</span>
            <strong>Connect inbox and calendar sync so reminders and communications stay matter-linked.</strong>
          </div>
          <div className="settings-item">
            <span>Onboarding</span>
            <strong>Keep agreement, signature, and firm identity current for intake acceptance.</strong>
          </div>
          <div className="settings-item">
            <span>Coverage Map</span>
            <strong>Use verified address + county coverage to improve automatic attorney matching.</strong>
          </div>
        </div>
      </section>

      <div id="firm-editor" style={{ marginTop: 18 }}>
        <MyFirmEditor
          initial={initial}
          message={params?.message}
          countiesByState={countiesByState}
          mapsEnabled={mapsEnabled}
        />
      </div>
    </AttorneyWorkspaceLayout>
  )
}

