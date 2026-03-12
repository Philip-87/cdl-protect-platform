import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { createClient } from '@/app/lib/supabase/server'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { getAttorneyWorkspaceSummary } from '@/app/attorney/lib/workspace'

type OnboardingProfileRow = {
  id: string
  fee_mode: string | null
  cdl_flat_fee: number | null
  non_cdl_flat_fee: number | null
  counties: unknown
}

type CountyFeeRow = {
  county_name: string
  cdl_fee: number | null
  non_cdl_fee: number | null
}

function normalizeCounties(raw: unknown) {
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

export default async function AttorneyCoverageFeesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/attorney/login?message=Please%20sign%20in.')
  }

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
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/dashboard?message=Attorney%20portal%20requires%20an%20attorney%20or%20admin%20role.')
  }

  const onboardingRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('id, fee_mode, cdl_flat_fee, non_cdl_flat_fee, counties')
    .eq('user_id', user.id)
    .maybeSingle<OnboardingProfileRow>()

  const onboarding = onboardingRes.data
  const countyFeesRes = onboarding?.id
    ? await supabase
        .from('attorney_county_fees')
        .select('county_name, cdl_fee, non_cdl_fee')
        .eq('attorney_profile_id', onboarding.id)
        .order('county_name', { ascending: true })
        .limit(250)
    : { data: [] as CountyFeeRow[] }

  const countyFees = (countyFeesRes.data ?? []) as CountyFeeRow[]
  const coverageCounties = normalizeCounties(onboarding?.counties)
  const workspaceSummary = getAttorneyWorkspaceSummary(onboarding)

  return (
    <AttorneyWorkspaceLayout
      active="coverage"
      title="Coverage & Fees"
      description="Control jurisdiction coverage, fee logic, and routing readiness so new matters land with the right attorney and pricing rules."
      actions={
        <>
          <Link href="/attorney/my-firm" className="button-link secondary">
            My Firm
          </Link>
          <Link href="/attorney/onboarding" className="button-link secondary">
            Edit onboarding
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#coverage-summary" className="workspace-subnav-link active">
            Summary
          </a>
          <a href="#county-fees" className="workspace-subnav-link">
            County Fees
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Coverage</span>
            <strong>{workspaceSummary.coverageStateCount} states</strong>
            <span>{workspaceSummary.countyCount} counties</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Fee Mode</span>
            <strong>{workspaceSummary.feeMode === 'BY_COUNTY' ? 'County pricing' : 'Global pricing'}</strong>
            <span>{countyFees.length} county overrides</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Profile Readiness</span>
            <strong>{workspaceSummary.profileCompletion}%</strong>
            <span>Routing completeness</span>
          </article>
        </>
      }
    >
      {!onboarding ? (
        <section className="card" style={{ marginTop: 0 }}>
          <p style={{ margin: 0, color: '#5e6068' }}>
            No onboarding profile found. Complete attorney onboarding to configure coverage and fees.
          </p>
          <div style={{ marginTop: 10 }}>
            <Link href="/attorney/onboarding" className="button-link primary">
              Open Onboarding
            </Link>
          </div>
        </section>
      ) : (
        <section className="card" style={{ marginTop: 0 }} id="coverage-summary">
          <div className="grid-2">
            <div>
              <p style={{ margin: 0 }}>
                <strong>Fee Mode:</strong> {onboarding.fee_mode || 'GLOBAL'}
              </p>
              {onboarding.fee_mode === 'BY_COUNTY' ? (
                <p style={{ marginTop: 8, color: '#5e6068' }}>
                  County-based pricing configured for {countyFees.length} counties.
                </p>
              ) : (
                <p style={{ marginTop: 8, color: '#5e6068' }}>
                  Global Fees: CDL {onboarding.cdl_flat_fee ?? '-'} | Non-CDL {onboarding.non_cdl_flat_fee ?? '-'}
                </p>
              )}
            </div>
            <div>
              <p style={{ margin: 0 }}>
                <strong>Coverage Counties:</strong> {coverageCounties.length}
              </p>
              <p style={{ marginTop: 8, color: '#5e6068' }}>
                {coverageCounties.length ? coverageCounties.slice(0, 14).join(', ') : 'No counties selected yet.'}
                {coverageCounties.length > 14 ? ' ...' : ''}
              </p>
            </div>
          </div>

          {onboarding.fee_mode === 'BY_COUNTY' && countyFees.length ? (
            <div style={{ marginTop: 12, overflowX: 'auto' }} id="county-fees">
              <table className="case-table" style={{ minWidth: 420 }}>
                <thead>
                  <tr>
                    <th>County</th>
                    <th>CDL Fee</th>
                    <th>Non-CDL Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {countyFees.map((row) => (
                    <tr key={row.county_name}>
                      <td>{row.county_name}</td>
                      <td>{row.cdl_fee ?? '-'}</td>
                      <td>{row.non_cdl_fee ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link href="/attorney/my-firm" className="button-link secondary">
              Open My Firm
            </Link>
            <Link href="/attorney/onboarding" className="button-link secondary">
              Edit Onboarding
            </Link>
          </div>
        </section>
      )}
    </AttorneyWorkspaceLayout>
  )
}
