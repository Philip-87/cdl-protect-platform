'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { syncAttorneyMatchingCoverageForUser } from '@/app/lib/matching/attorneyCoverageSync'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'

function parseString(value: FormDataEntryValue | null) {
  return String(value ?? '').trim()
}

function parseJsonArray(raw: string) {
  if (!raw) return [] as string[]
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.map((item) => String(item).trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function getAttorneyContext() {
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
    redirect('/dashboard?message=Attorney%20firm%20profile%20requires%20an%20attorney%20or%20admin%20role.')
  }

  return { supabase, user }
}

export async function saveAttorneyFirmProfile(formData: FormData) {
  const { supabase, user } = await getAttorneyContext()

  const fullName = parseString(formData.get('full_name'))
  const email = parseString(formData.get('email')).toLowerCase()
  const phone = parseString(formData.get('phone'))
  const state = parseString(formData.get('state')).toUpperCase()
  const officeAddress = parseString(formData.get('office_address'))
  const city = parseString(formData.get('city'))
  const zipCode = parseString(formData.get('zip_code'))
  const counties = parseJsonArray(parseString(formData.get('counties_json')))
  const coverageStates = parseJsonArray(parseString(formData.get('coverage_states_json'))).map((value) =>
    value.toUpperCase()
  )
  const primaryCounty = parseString(formData.get('primary_county'))

  if (!fullName || !email || !phone || !state || !officeAddress || !zipCode) {
    redirect('/attorney/my-firm?message=Complete%20all%20required%20fields.')
  }

  const onboardingRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('id, metadata')
    .eq('user_id', user.id)
    .maybeSingle<{ id: string; metadata: Record<string, unknown> | null }>()

  if (!onboardingRes.data?.id) {
    redirect('/attorney/onboarding?message=Complete%20onboarding%20before%20editing%20your%20firm%20profile.')
  }

  const onboardingId = onboardingRes.data.id
  const metadata = onboardingRes.data.metadata ?? {}
  const nextMetadata = {
    ...metadata,
    coverage_states: coverageStates.length ? coverageStates : [state],
    primary_county: primaryCounty || counties[0] || null,
    county_count: counties.length,
  }

  const updateOnboarding = await supabase
    .from('attorney_onboarding_profiles')
    .update({
      full_name: fullName,
      email,
      phone,
      state,
      office_address: officeAddress,
      city: city || null,
      zip_code: zipCode,
      counties,
      coverage_states: coverageStates.length ? coverageStates : [state],
      primary_county: primaryCounty || counties[0] || null,
      metadata: nextMetadata,
    })
    .eq('id', onboardingId)

  if (updateOnboarding.error) {
    redirect(`/attorney/my-firm?message=${encodeURIComponent(updateOnboarding.error.message)}`)
  }

  const membershipRes = await supabase
    .from('attorney_firm_memberships')
    .select('firm_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ firm_id: string }>()

  const firmId = membershipRes.data?.firm_id
  if (firmId) {
    const updateFirm = await supabase
      .from('attorney_firms')
      .update({
        contact_name: fullName,
        email,
        phone,
        state,
        counties,
        coverage_states: coverageStates.length ? coverageStates : [state],
        primary_county: primaryCounty || counties[0] || null,
        office_address: officeAddress,
        city: city || null,
        zip_code: zipCode,
      })
      .eq('id', firmId)

    if (updateFirm.error) {
      redirect(`/attorney/my-firm?message=${encodeURIComponent(updateFirm.error.message)}`)
    }
  }

  try {
    await syncAttorneyMatchingCoverageForUser(user.id)
  } catch (error) {
    console.error('Attorney firm matching sync failed:', error)
  }

  revalidatePath('/attorney/my-firm')
  revalidatePath('/attorney/onboarding')
  revalidatePath('/attorney/dashboard')
  redirect('/attorney/my-firm?message=Firm%20profile%20updated.')
}
