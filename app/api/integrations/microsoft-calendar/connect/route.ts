import { NextResponse } from 'next/server'
import { buildCalendarConnectUrl } from '@/app/lib/server/calendar-sync'
import { issueCalendarOauthState } from '@/app/lib/server/calendar-sync-crypto'
import { getEnabledFeaturesForRole, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { createClient } from '@/app/lib/supabase/server'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'

function redirectWithMessage(requestUrl: string, path: string, message: string) {
  const url = new URL(path.startsWith('/') ? path : '/attorney/integrations', requestUrl)
  url.searchParams.set('message', message)
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const requestUrl = request.url
  const returnTo = (() => {
    const url = new URL(request.url)
    const raw = String(url.searchParams.get('return_to') ?? '').trim()
    return raw.startsWith('/') ? raw : '/attorney/integrations'
  })()

  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return redirectWithMessage(
        requestUrl,
        `/attorney/login?redirectedFrom=${encodeURIComponent('/api/integrations/microsoft-calendar/connect')}`,
        'Please sign in before connecting Microsoft Calendar.'
      )
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
      return redirectWithMessage(requestUrl, returnTo, 'Attorney or admin role required to connect a calendar.')
    }
    const featureState = await loadRoleFeatureOverrides(supabase)
    const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
    if (!enabledFeatures.includes('attorney_calendar_sync')) {
      return redirectWithMessage(requestUrl, returnTo, 'Calendar sync is disabled for this role.')
    }

    const state = issueCalendarOauthState({
      userId: user.id,
      provider: 'MICROSOFT',
      returnTo,
    })
    return NextResponse.redirect(buildCalendarConnectUrl('MICROSOFT', state))
  } catch (error) {
    return redirectWithMessage(
      requestUrl,
      returnTo,
      error instanceof Error ? error.message : 'Could not start Microsoft Calendar connection.'
    )
  }
}
