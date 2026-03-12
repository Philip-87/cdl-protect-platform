import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { getAttorneyWorkspaceSummary } from '@/app/attorney/lib/workspace'
import { createClient } from '@/app/lib/supabase/server'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { isMapsApiKeyConfigured } from '@/app/lib/server/maps'
import OnboardingWizard from './OnboardingWizard'

type OnboardingProfileRow = {
  id: string
  full_name: string | null
  email: string | null
  phone: string | null
  state: string | null
  office_address: string | null
  city: string | null
  zip_code: string | null
  payment_methods: string[] | null
  payment_identifier: string | null
  other_payment: string | null
  fee_mode: string | null
  cdl_flat_fee: number | null
  non_cdl_flat_fee: number | null
  counties: unknown
  coverage_states: unknown
  agreed_to_terms: boolean | null
  signature_text: string | null
  metadata: Record<string, unknown> | null
}

type CountyFeeRow = {
  county_name: string
  cdl_fee: number | null
  non_cdl_fee: number | null
}

type CaseCountyRow = {
  state: string
  county: string | null
}

type CountyReferenceRow = {
  state_code: string
  county_name: string
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

function parseStep(value: string | undefined) {
  const parsed = Number(value ?? '')
  if (!Number.isFinite(parsed)) return 1
  return Math.min(4, Math.max(1, Math.round(parsed)))
}

export default async function AttorneyOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; step?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/attorney/login?redirectedFrom=/attorney/onboarding&message=Please%20sign%20in.')
  }

  // Retry invite claim on page entry so invite-based accounts can self-heal
  // even if a prior login callback did not complete the role bootstrap.
  try {
    await supabase.rpc('claim_my_invites')
  } catch {
    // no-op
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
    redirect('/dashboard?message=Attorney%20onboarding%20requires%20an%20attorney%20or%20admin%20role.')
  }

  const onboardingRes = await supabase
    .from('attorney_onboarding_profiles')
    .select(
      'id, full_name, email, phone, state, office_address, city, zip_code, payment_methods, payment_identifier, other_payment, fee_mode, cdl_flat_fee, non_cdl_flat_fee, counties, coverage_states, agreed_to_terms, signature_text, metadata'
    )
    .eq('user_id', user.id)
    .maybeSingle<OnboardingProfileRow>()

  const onboarding = onboardingRes.data
  const countyFeesRes =
    onboarding?.id
      ? await supabase
          .from('attorney_county_fees')
          .select('county_name, cdl_fee, non_cdl_fee')
          .eq('attorney_profile_id', onboarding.id)
          .order('county_name', { ascending: true })
      : { data: [], error: null }

  const countyFees = (countyFeesRes.data ?? []) as CountyFeeRow[]
  const [countyReferenceRes, caseCountyRes] = await Promise.all([
    supabase.from('county_reference').select('state_code, county_name').order('state_code', { ascending: true }).limit(12000),
    supabase.from('cases').select('state, county').not('county', 'is', null).limit(3000),
  ])

  const suggestedCountiesByState: Record<string, string[]> = {}
  for (const row of (countyReferenceRes.data ?? []) as CountyReferenceRow[]) {
    const state = String(row.state_code ?? '').trim().toUpperCase()
    const county = String(row.county_name ?? '').trim()
    if (!state || !county) continue
    if (!suggestedCountiesByState[state]) suggestedCountiesByState[state] = []
    if (!suggestedCountiesByState[state].includes(county)) {
      suggestedCountiesByState[state].push(county)
    }
  }

  for (const row of (caseCountyRes.data ?? []) as CaseCountyRow[]) {
    const state = String(row.state ?? '').trim().toUpperCase()
    const county = String(row.county ?? '').trim()
    if (!state || !county) continue
    if (!suggestedCountiesByState[state]) suggestedCountiesByState[state] = []
    if (!suggestedCountiesByState[state].includes(county)) {
      suggestedCountiesByState[state].push(county)
    }
  }

  Object.keys(suggestedCountiesByState).forEach((state) => {
    suggestedCountiesByState[state].sort((a, b) => a.localeCompare(b))
  })

  const paymentDetailsRaw = (onboarding?.metadata?.['payment_details'] ?? {}) as Record<string, unknown>

  const initial = {
    fullName: onboarding?.full_name ?? profileByUserId?.full_name ?? '',
    email: onboarding?.email ?? profileByUserId?.email ?? user.email ?? '',
    phone: onboarding?.phone ?? '',
    state: onboarding?.state ?? '',
    officeAddress: onboarding?.office_address ?? '',
    city: onboarding?.city ?? '',
    zipCode: onboarding?.zip_code ?? '',
    paymentMethods: onboarding?.payment_methods ?? [],
    paymentIdentifier: onboarding?.payment_identifier ?? '',
    otherPayment: onboarding?.other_payment ?? '',
    paymentDetails: {
      achBankName: String(paymentDetailsRaw['achBankName'] ?? ''),
      achAccountNumber: String(paymentDetailsRaw['achAccountNumber'] ?? ''),
      achRoutingNumber: String(paymentDetailsRaw['achRoutingNumber'] ?? ''),
      zelleContact: String(paymentDetailsRaw['zelleContact'] ?? ''),
      lawpayAccount: String(paymentDetailsRaw['lawpayAccount'] ?? ''),
      stripeAccount: String(paymentDetailsRaw['stripeAccount'] ?? ''),
      paypalContact: String(paymentDetailsRaw['paypalContact'] ?? ''),
      otherDetails: String(paymentDetailsRaw['otherDetails'] ?? onboarding?.other_payment ?? ''),
    },
    feeMode: onboarding?.fee_mode === 'BY_COUNTY' ? ('BY_COUNTY' as const) : ('GLOBAL' as const),
    cdlFlatFee:
      onboarding?.cdl_flat_fee !== null && onboarding?.cdl_flat_fee !== undefined
        ? String(onboarding.cdl_flat_fee)
        : '',
    nonCdlFlatFee:
      onboarding?.non_cdl_flat_fee !== null && onboarding?.non_cdl_flat_fee !== undefined
        ? String(onboarding.non_cdl_flat_fee)
        : '',
    counties: normalizeCounties(onboarding?.counties),
    countyFees: countyFees.map((row) => ({
      county: row.county_name,
      cdlFee: row.cdl_fee,
      nonCdlFee: row.non_cdl_fee,
    })),
    agreedToTerms: Boolean(onboarding?.agreed_to_terms),
    signatureText: onboarding?.signature_text ?? '',
  }

  const computedStep = initial.agreedToTerms && initial.signatureText.trim() ? 4 : parseStep(params?.step)
  const mapsEnabled = isMapsApiKeyConfigured()
  const workspaceSummary = getAttorneyWorkspaceSummary(onboarding)

  return (
    <AttorneyWorkspaceLayout
      active="onboarding"
      title="Attorney Onboarding"
      description="Complete identity, pricing, coverage, and agreement setup so new traffic matters can route into your workspace without manual cleanup."
      actions={
        <>
          <Link href="/attorney/my-firm" className="button-link secondary">
            My Firm
          </Link>
          <Link href="/attorney/dashboard" className="button-link secondary">
            Dashboard
          </Link>
        </>
      }
      subnav={
        <>
          <a href="#onboarding-identity" className="workspace-subnav-link active">
            Identity
          </a>
          <a href="#onboarding-pricing" className="workspace-subnav-link">
            Coverage & Fees
          </a>
          <a href="#onboarding-agreement" className="workspace-subnav-link">
            Agreement
          </a>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Profile Completion</span>
            <strong>{workspaceSummary.profileCompletion}%</strong>
            <span>Routing profile readiness</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Coverage</span>
            <strong>{workspaceSummary.coverageStateCount} states</strong>
            <span>{workspaceSummary.countyCount} counties saved</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Fee Logic</span>
            <strong>{workspaceSummary.feeMode === 'BY_COUNTY' ? 'County overrides' : 'Global pricing'}</strong>
            <span>{initial.countyFees.length} county fee rows</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Maps Verification</span>
            <strong>{mapsEnabled ? 'Enabled' : 'Manual mode'}</strong>
            <span>{mapsEnabled ? 'Autocomplete and county suggestions available' : 'Configure GMAPS_API_KEY for verification'}</span>
          </article>
        </>
      }
    >
      <OnboardingWizard
        initial={initial}
        initialStep={computedStep}
        message={params?.message}
        suggestedCountiesByState={suggestedCountiesByState}
        mapsEnabled={mapsEnabled}
        embedded
      />
    </AttorneyWorkspaceLayout>
  )
}
