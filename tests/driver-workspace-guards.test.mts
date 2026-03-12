import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function readSource(path: string) {
  return readFileSync(path, 'utf8')
}

test('driver navigation hides fleet workspace links', () => {
  const topNav = readSource('app/components/AppTopNav.tsx')
  const sidebar = readSource('app/components/AgencyWorkspaceLayout.tsx')

  assert.match(topNav, /roleHasFleetWorkspace/)
  assert.match(topNav, /\/notifications#notification-inbox/)
  assert.match(sidebar, /roleHasFleetWorkspace/)
  assert.match(sidebar, /Notifications/)
})

test('driver pages guard or remove fleet-specific actions', () => {
  const dashboard = readSource('app/dashboard/page.tsx')
  const intake = readSource('app/intake/page.tsx')
  const settings = readSource('app/settings/page.tsx')
  const myFleets = readSource('app/my-fleets/page.tsx')

  assert.match(dashboard, /effectiveFleetFilter/)
  assert.match(dashboard, /hasFleetWorkspace/)
  assert.match(intake, /roleHasFleetWorkspace/)
  assert.match(settings, /Fleet Options/)
  assert.match(myFleets, /Fleet%20options%20are%20not%20available%20for%20this%20account/)
})

test('agency signup and invite flow includes agency role support', () => {
  const signupPage = readSource('app/signup/page.tsx')
  const signupActions = readSource('app/signup/actions.ts')
  const migration = readSource('supabase/migrations/202603100011_agency_signup_and_invite_scope.sql')

  assert.match(signupPage, /value="AGENCY"/)
  assert.match(signupActions, /requestedRoleRaw === 'AGENCY'/)
  assert.match(migration, /requested_role not in \('DRIVER', 'FLEET', 'AGENCY'\)/)
  assert.match(migration, /upper\(coalesce\(platform_invites\.target_role, ''\)\) = 'AGENCY'/)
})

test('driver case access migration claims and links driver cases', () => {
  const migration = readSource('supabase/migrations/202603100012_driver_case_linking.sql')
  const claimInvites = readSource('app/lib/server/claim-invites.ts')
  const intake = readSource('app/intake/submit-core.ts')

  assert.match(migration, /create or replace function public\.claim_my_driver_cases/)
  assert.match(migration, /set driver_id = uid/)
  assert.match(migration, /c\.driver_id = uid/)
  assert.match(claimInvites, /claim_my_driver_cases/)
  assert.match(intake, /findDriverIdByEmail/)
})

test('shared notifications and scoped invite visibility are production-wired', () => {
  const features = readSource('app/lib/features.ts')
  const layout = readSource('app/layout.tsx')
  const notificationsPage = readSource('app/notifications/page.tsx')
  const inviteSelectMigration = readSource('supabase/migrations/202603100013_platform_invite_select_scope.sql')

  assert.match(features, /key: 'notification_inbox'/)
  assert.match(layout, /workspaceSignals/)
  assert.match(notificationsPage, /Notifications/)
  assert.match(inviteSelectMigration, /create policy "platform_invites_select_scope"/)
  assert.match(inviteSelectMigration, /upper\(coalesce\(platform_invites\.target_role, ''\)\) in \('FLEET', 'DRIVER'\)/)
})
