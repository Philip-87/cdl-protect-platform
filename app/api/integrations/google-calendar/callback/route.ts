import { NextResponse } from 'next/server'
import { queueCalendarFullSyncForIntegration } from '@/app/lib/server/attorney-calendar-runtime'
import {
  exchangeCalendarProviderCode,
  fetchCalendarProviderProfile,
  updateAttorneyIntegrationMetadata,
  upsertCalendarIntegration,
} from '@/app/lib/server/calendar-sync'
import { verifyCalendarOauthState } from '@/app/lib/server/calendar-sync-crypto'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'

function buildRedirectUrl(requestUrl: string, path: string, message: string) {
  const url = new URL(path.startsWith('/') ? path : '/attorney/integrations', requestUrl)
  url.searchParams.set('message', message)
  return url
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const stateToken = String(url.searchParams.get('state') ?? '').trim()
  const state = verifyCalendarOauthState(stateToken)
  const returnTo = state.ok ? state.payload.returnTo : '/attorney/integrations'

  if (!state.ok) {
    return NextResponse.redirect(buildRedirectUrl(request.url, returnTo, state.message))
  }
  if (state.payload.provider !== 'GOOGLE') {
    return NextResponse.redirect(buildRedirectUrl(request.url, returnTo, 'OAuth state does not match Google Calendar.'))
  }

  const oauthError = String(url.searchParams.get('error') ?? '').trim()
  if (oauthError) {
    const description = String(url.searchParams.get('error_description') ?? '').trim()
    return NextResponse.redirect(
      buildRedirectUrl(request.url, returnTo, description || `Google Calendar connection failed: ${oauthError}`)
    )
  }

  const code = String(url.searchParams.get('code') ?? '').trim()
  if (!code) {
    return NextResponse.redirect(buildRedirectUrl(request.url, returnTo, 'Google Calendar callback is missing the authorization code.'))
  }

  try {
    const supabase = createServiceRoleClient()
    const tokens = await exchangeCalendarProviderCode('GOOGLE', code)
    const profile = await fetchCalendarProviderProfile('GOOGLE', tokens.accessToken)
    const integrationId = await upsertCalendarIntegration({
      supabase,
      userId: state.payload.sub,
      provider: 'GOOGLE',
      accountEmail: profile.accountEmail,
      calendarId: profile.calendarId,
      tokens,
      metadata: {
        display_name: profile.displayName,
      },
    })

    await updateAttorneyIntegrationMetadata(supabase, {
      userId: state.payload.sub,
      provider: 'GOOGLE',
      calendarEmail: profile.accountEmail,
    })
    await queueCalendarFullSyncForIntegration({ integrationId })

    return NextResponse.redirect(
      buildRedirectUrl(request.url, returnTo, 'Google Calendar connected. Initial sync queued.')
    )
  } catch (error) {
    return NextResponse.redirect(
      buildRedirectUrl(
        request.url,
        returnTo,
        error instanceof Error ? error.message : 'Could not complete Google Calendar connection.'
      )
    )
  }
}
