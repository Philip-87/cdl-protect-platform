import type { Metadata } from 'next'
import { Suspense } from 'react'
import AuthCallbackBridge from '@/app/components/AuthCallbackBridge'
import AppTopNav from '@/app/components/AppTopNav'
import { getAttorneyWorkspaceSummary } from '@/app/attorney/lib/workspace'
import { getCalendarIntegrationOverview } from '@/app/lib/server/calendar-sync'
import { claimRoleInvitesSafe } from '@/app/lib/server/claim-invites'
import { getEnabledFeaturesForRole, hasPlatformFeature, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { createClient } from '@/app/lib/supabase/server'
import { isAttorneyRole, normalizePlatformRole } from '@/app/lib/roles'
import { syncProfileRoleFromMetadata } from '@/app/lib/server/profile-role-sync'
import './globals.css'

export const metadata: Metadata = {
  title: 'CDL Protect Platform',
  description: 'Traffic ticket intake and case operations for CDL drivers',
}

async function resolveViewer() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) return null
    await syncProfileRoleFromMetadata(user)
    await claimRoleInvitesSafe()

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
    const featureState = await loadRoleFeatureOverrides(supabase)
    const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
    const shouldLoadUnreadNotifications = isAttorneyRole(role) || hasPlatformFeature(enabledFeatures, 'notification_inbox')
    const unreadNotificationsRes = shouldLoadUnreadNotifications
      ? await supabase.from('in_app_notifications').select('id', { count: 'exact', head: true }).eq('user_id', user.id).is('read_at', null)
      : null
    const unreadNotifications =
      unreadNotificationsRes && !unreadNotificationsRes.error ? unreadNotificationsRes.count ?? 0 : 0

    if (!isAttorneyRole(role)) {
      return {
        role,
        email: user.email ?? null,
        enabledFeatures,
        workspaceSignals: hasPlatformFeature(enabledFeatures, 'notification_inbox')
          ? {
              unreadNotifications,
            }
          : null,
      }
    }

    const attorneyProfileRes = await supabase
      .from('attorney_onboarding_profiles')
      .select(
        'full_name, email, phone, state, office_address, city, zip_code, counties, coverage_states, fee_mode, cdl_flat_fee, non_cdl_flat_fee, agreed_to_terms, signature_text, metadata'
      )
      .eq('user_id', user.id)
      .maybeSingle()

    const workspaceSummary = getAttorneyWorkspaceSummary(attorneyProfileRes.data ?? null)
    const calendarOverview = await getCalendarIntegrationOverview(supabase, user.id)
    const preferredCalendar = calendarOverview.preferred

    const openTasksRes = await supabase
      .from('case_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('target_role', 'ATTORNEY')
      .in('status', ['OPEN', 'PENDING'])

    const membershipSelects = ['firm_id, law_firm_org_id', 'firm_id', 'law_firm_org_id']
    let firmIds: string[] = []
    for (const selectClause of membershipSelects) {
      const membershipsRes = await supabase.from('attorney_firm_memberships').select(selectClause).eq('user_id', user.id).limit(20)
      if (membershipsRes.error) {
        const message = membershipsRes.error.message
        const isSchemaDrift =
          membershipsRes.error.code === 'PGRST204' ||
          /column .* does not exist/i.test(message) ||
          /could not find the '.*' column/i.test(message) ||
          /schema cache/i.test(message)
        if (isSchemaDrift) continue
        break
      }

      firmIds = [
        ...new Set(
          (membershipsRes.data ?? [])
            .map((row) => {
              const record = row as { firm_id?: string | null; law_firm_org_id?: string | null }
              return String(record.firm_id ?? record.law_firm_org_id ?? '').trim()
            })
            .filter(Boolean)
        ),
      ]
      break
    }
    let pendingOffers = 0

    if (firmIds.length) {
      const combinedOfferRes = await supabase
        .from('case_assignments')
        .select('id', { count: 'exact', head: true })
        .or(`firm_id.in.(${firmIds.join(',')}),law_firm_org_id.in.(${firmIds.join(',')})`)
        .is('accepted_at', null)
        .is('declined_at', null)

      if (!combinedOfferRes.error) {
        pendingOffers = combinedOfferRes.count ?? 0
      } else {
        const legacyOfferRes = await supabase
          .from('case_assignments')
          .select('id', { count: 'exact', head: true })
          .in('firm_id', firmIds)
          .is('accepted_at', null)
          .is('declined_at', null)

        pendingOffers = legacyOfferRes.count ?? 0
      }
    }

    return {
      role,
      email: user.email ?? null,
      enabledFeatures,
      attorneySignals: {
        emailSyncConnected: workspaceSummary.emailSyncConnected,
        emailSyncLabel: workspaceSummary.emailSyncConnected
          ? `${workspaceSummary.emailSyncLabel} synced`
          : 'Inbox manual',
        calendarSyncConnected: Boolean(preferredCalendar) || workspaceSummary.calendarSyncConnected,
        calendarSyncLabel: preferredCalendar
          ? preferredCalendar.last_sync_status === 'ERROR'
            ? `${preferredCalendar.provider === 'MICROSOFT' ? 'Microsoft' : 'Google'} error`
            : `${preferredCalendar.provider === 'MICROSOFT' ? 'Microsoft' : 'Google'} synced`
          : workspaceSummary.calendarSyncConnected
            ? 'Calendar synced'
            : 'Calendar manual',
        openTasks: openTasksRes.count ?? 0,
        pendingOffers,
        unreadNotifications,
      },
    }
  } catch {
    return null
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const viewer = await resolveViewer()

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
                try {
                  const stored = localStorage.getItem('cdl-theme');
                  const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  const theme = stored === 'dark' || stored === 'light' ? stored : fallback;
                  document.documentElement.setAttribute('data-theme', theme);
                } catch {}
              })();
            `,
          }}
        />
      </head>
      <body>
        <AuthCallbackBridge />
        <Suspense fallback={<div className="site-header-skeleton" />}>
          <AppTopNav viewer={viewer} />
        </Suspense>
        <main className="app-main">
          <div className="container app-main-inner">{children}</div>
        </main>
      </body>
    </html>
  )
}
