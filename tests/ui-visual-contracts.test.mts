import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function readSource(path: string) {
  return readFileSync(path, 'utf8')
}

test('dashboard page keeps the shared case queue contract', () => {
  const source = readSource('app/dashboard/page.tsx')

  assert.match(source, /SharedCaseQueueTable/)
  assert.match(source, /id="case-queue"/)
  assert.match(source, /id="selected-case"/)
  assert.match(source, /queueExtraColumns/)
})

test('my fleets page keeps the redesigned fleet workspace contract', () => {
  const source = readSource('app/my-fleets/page.tsx')

  assert.match(source, /Fleet Directory/)
  assert.match(source, /Driver Roster/)
  assert.match(source, /workspace-subnav/)
  assert.match(source, /Download Cases CSV Template/)
  assert.match(source, /FleetActionMenu/)
})

test('shared notifications page keeps inbox controls available', () => {
  const source = readSource('app/notifications/page.tsx')

  assert.match(source, /Notification Inbox/)
  assert.match(source, /Mark All Read/)
  assert.match(source, /Background reminders, payment requests, and calendar jobs write in-app alerts here/)
})

test('settings page keeps the operational settings sections', () => {
  const source = readSource('app/settings/page.tsx')

  assert.match(source, /Identity and session/)
  assert.match(source, /Agency and fleet scope/)
  assert.match(source, /Billing ownership and support/)
})

test('workspace shell keeps mobile drawer and compact action bar hooks', () => {
  const layoutSource = readSource('app/components/AgencyWorkspaceLayout.tsx')
  const cssSource = readSource('app/globals.css')

  assert.match(layoutSource, /workspace-drawer-toggle/)
  assert.match(layoutSource, /workspace-mobile-drawer/)
  assert.match(layoutSource, /workspace-compact-actions/)
  assert.match(cssSource, /\.workspace-mobile-controls/)
  assert.match(cssSource, /\.workspace-mobile-drawer/)
  assert.match(cssSource, /\.workspace-compact-actions/)
  assert.match(cssSource, /\.shared-case-queue-table/)
})

test('admin cases page keeps attorney matching controls available', () => {
  const source = readSource('app/admin/cases/page.tsx')

  assert.match(source, /Attorney Matching/)
  assert.match(source, /Run Automatic Matching/)
  assert.match(source, /Create Manual Match/)
  assert.match(source, /Pending Outreach/)
  assert.match(source, /Uploaded By/)
  assert.match(source, /Uploaded Role/)
  assert.match(source, /Submitter and Uploader/)
})

test('case details page keeps submitter info and staff attorney matching controls', () => {
  const source = readSource('app/cases/[id]/page.tsx')

  assert.match(source, /Submitter Name:/)
  assert.match(source, /Submitter Email:/)
  assert.match(source, /Uploaded By Account:/)
  assert.match(source, /Add Hearing/)
  assert.match(source, /Add Follow-Up/)
  assert.match(source, /Open Case Calendar/)
  assert.match(source, /Run Automatic Matching/)
  assert.match(source, /Create Manual Match/)
})

test('attorney calendar keeps the advanced legal scheduling workspace contract', () => {
  const pageSource = readSource('app/attorney/calendar/page.tsx')
  const workspaceSource = readSource('app/attorney/calendar/AttorneyCalendarWorkspace.tsx')

  assert.match(pageSource, /AttorneyCalendarWorkspace/)
  assert.match(pageSource, /Apply the attorney calendar migration/)
  assert.match(workspaceSource, /Day Detail/)
  assert.match(workspaceSource, /Working hours and defaults/)
  assert.match(workspaceSource, /Team Overlay/)
  assert.match(workspaceSource, /Open Linked Case/)
  assert.match(workspaceSource, /Integration Readiness/)
  assert.match(workspaceSource, /Provider status:/)
})

test('attorney integrations page keeps provider sync controls available', () => {
  const source = readSource('app/attorney/integrations/page.tsx')

  assert.match(source, /Google Calendar/)
  assert.match(source, /Microsoft 365 Calendar/)
  assert.match(source, /Sync Now/)
  assert.match(source, /Disconnect/)
  assert.match(source, /Email and Billing Metadata/)
})

test('attorney reminders page keeps background notification inbox controls', () => {
  const source = readSource('app/attorney/reminders/page.tsx')

  assert.match(source, /Notification Inbox/)
  assert.match(source, /Mark All Read/)
  assert.match(source, /Background reminder delivery writes in-app alerts here/)
})

test('admin users page keeps platform role feature controls available', () => {
  const source = readSource('app/admin/users/page.tsx')

  assert.match(source, /Platform Role Feature Controls/)
  assert.match(source, /Save \{roleOption\} Controls/)
  assert.match(source, /Role Controls/)
})
