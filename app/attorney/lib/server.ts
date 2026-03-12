import { redirect } from 'next/navigation'
import { getEnabledFeaturesForRole, hasPlatformFeature, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { createClient } from '@/app/lib/supabase/server'
import type { PlatformFeatureKey } from '@/app/lib/features'
import { isAttorneyRole, isStaffRole, normalizePlatformRole, type PlatformRole } from '@/app/lib/roles'

export type AttorneyViewer = {
  supabase: Awaited<ReturnType<typeof createClient>>
  user: { id: string; email: string | null }
  role: PlatformRole
  displayEmail: string
  enabledFeatures: PlatformFeatureKey[]
}

export async function requireAttorneyViewer(): Promise<AttorneyViewer> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/attorney/login?message=Please%20sign%20in.')
  }

  const profileById = await supabase
    .from('profiles')
    .select('email, system_role')
    .eq('id', user.id)
    .maybeSingle<{ email: string | null; system_role: string | null }>()

  const profileByUserId =
    profileById.data ||
    (
      await supabase
        .from('profiles')
        .select('email, system_role')
        .eq('user_id', user.id)
        .maybeSingle<{ email: string | null; system_role: string | null }>()
    ).data

  const role = normalizePlatformRole(profileByUserId?.system_role)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/dashboard?message=Attorney%20portal%20requires%20an%20attorney%20or%20admin%20role.')
  }
  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)

  return {
    supabase,
    user: { id: user.id, email: user.email ?? null },
    role,
    displayEmail: profileByUserId?.email ?? user.email ?? '',
    enabledFeatures,
  }
}

export function requireAttorneyFeature(
  viewer: Pick<AttorneyViewer, 'enabledFeatures'>,
  featureKey: PlatformFeatureKey,
  redirectPath = '/attorney/dashboard'
) {
  if (!hasPlatformFeature(viewer.enabledFeatures, featureKey)) {
    redirect(`${redirectPath}?message=${encodeURIComponent('This function is disabled for your role.')}`)
  }
}

export type AttorneyCaseOption = {
  id: string
  citation_number: string | null
  state: string
  county: string | null
  court_date: string | null
  status: string
}

export async function fetchAttorneyCaseOptions(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<AttorneyCaseOption[]> {
  const res = await supabase
    .from('cases')
    .select('id, citation_number, state, county, court_date, status')
    .order('updated_at', { ascending: false })
    .limit(500)

  return (res.data ?? []) as AttorneyCaseOption[]
}
