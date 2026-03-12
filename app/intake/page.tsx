import Link from 'next/link'
import { AgencyWorkspaceLayout } from '@/app/components/AgencyWorkspaceLayout'
import { getAccessibleFleetOptions } from '@/app/lib/server/fleet-access'
import { getEnabledFeaturesForRole, hasPlatformFeature, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { isAttorneyRole, normalizePlatformRole, roleHasFleetWorkspace } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'
import IntakeWizard from './IntakeWizard'

type FleetOption = {
  id: string
  company_name: string
}

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; fleet?: string }>
}) {
  const params = await searchParams
  let backHref = '/dashboard'
  let fleetOptions: FleetOption[] = []
  let role = normalizePlatformRole(null)
  let enabledFeatures: string[] = []

  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (user) {
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

      role = normalizePlatformRole(profileByUserId?.system_role)
      const featureState = await loadRoleFeatureOverrides(supabase)
      enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
      if (isAttorneyRole(role)) {
        backHref = '/attorney/dashboard'
      }

      fleetOptions = roleHasFleetWorkspace(role) ? ((await getAccessibleFleetOptions(supabase, user.id)) as FleetOption[]) : []
    }
  } catch {
    backHref = '/dashboard'
  }

  if (!hasPlatformFeature(enabledFeatures, 'ticket_intake')) {
    return <p className="notice">Ticket intake is currently disabled for this role.</p>
  }

  return (
    isAttorneyRole(role) ? (
      <div style={{ padding: '16px 0 28px' }}>
        <section className="page-header simple-page-header">
          <div className="page-header-copy">
            <p className="page-eyebrow">Attorney Intake</p>
            <h1 className="page-title">Advanced Ticket Intake</h1>
            <p className="page-description">Multi-step mission flow for fast, structured intake.</p>
          </div>
          <div className="page-header-actions">
            <Link href={backHref} className="button-link secondary">
              Back to Dashboard
            </Link>
          </div>
        </section>

        <IntakeWizard
          message={params?.message}
          fleets={fleetOptions}
          defaultFleetId={fleetOptions.some((fleet) => fleet.id === params?.fleet) ? String(params?.fleet) : ''}
          role={role}
        />
      </div>
    ) : (
      <AgencyWorkspaceLayout
        role={role}
        enabledFeatures={enabledFeatures}
        active="intake"
        title="Ticket Intake"
        description="Structured, OCR-assisted intake for traffic tickets, court dates, and fleet routing."
        actions={
          <>
            <Link href="/dashboard?tab=cases#case-queue" className="button-link secondary">
              Open Cases
            </Link>
            {roleHasFleetWorkspace(role) ? (
              <Link href="/my-fleets" className="button-link secondary">
                My Fleets
              </Link>
            ) : null}
          </>
        }
      >
        <IntakeWizard
          message={params?.message}
          fleets={fleetOptions}
          defaultFleetId={fleetOptions.some((fleet) => fleet.id === params?.fleet) ? String(params?.fleet) : ''}
          role={role}
        />
      </AgencyWorkspaceLayout>
    )
  )
}
