import type { PlatformRole } from '@/app/lib/roles'

export const PLATFORM_FEATURES = [
  {
    key: 'cases_workspace',
    label: 'Cases Workspace',
    description: 'Open case queues, case details, and case-level workflow actions.',
    category: 'Core workspace',
    defaultRoles: ['DRIVER', 'FLEET', 'AGENCY', 'ATTORNEY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'notification_inbox',
    label: 'Notification Inbox',
    description: 'Review in-app notifications for case updates, reminders, and background job alerts.',
    category: 'Core workspace',
    defaultRoles: ['DRIVER', 'FLEET', 'AGENCY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'ticket_intake',
    label: 'Ticket Intake',
    description: 'Create new tickets and intake new matters into the platform.',
    category: 'Core workspace',
    defaultRoles: ['DRIVER', 'FLEET', 'AGENCY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'fleet_workspace',
    label: 'Fleet Workspace',
    description: 'View fleets, ticket routing, and fleet-level notifications.',
    category: 'Fleet operations',
    defaultRoles: ['FLEET', 'AGENCY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'fleet_creation',
    label: 'Create Fleets',
    description: 'Create and edit fleet records.',
    category: 'Fleet operations',
    defaultRoles: ['FLEET', 'AGENCY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'invite_management',
    label: 'Invite Management',
    description: 'Send platform invites for fleet users, drivers, and staff.',
    category: 'Fleet operations',
    defaultRoles: ['FLEET', 'AGENCY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'csv_imports',
    label: 'CSV Imports',
    description: 'Bulk upload cases and operational data from CSV files.',
    category: 'Data tools',
    defaultRoles: ['FLEET', 'AGENCY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'attorney_calendar',
    label: 'Attorney Calendar',
    description: 'Use the legal scheduling workspace, event editor, and case calendar view.',
    category: 'Attorney workspace',
    defaultRoles: ['ATTORNEY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'attorney_calendar_sync',
    label: 'Calendar Sync',
    description: 'Connect Google or Microsoft calendars and run import/export sync.',
    category: 'Attorney workspace',
    defaultRoles: ['ATTORNEY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'attorney_communications',
    label: 'Attorney Communications',
    description: 'Use attorney-side matter communications and message review.',
    category: 'Attorney workspace',
    defaultRoles: ['ATTORNEY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'attorney_tasks',
    label: 'Attorney Tasks',
    description: 'Use attorney task queues and task-linked follow-up workflows.',
    category: 'Attorney workspace',
    defaultRoles: ['ATTORNEY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'attorney_reminders',
    label: 'Attorney Reminders',
    description: 'Use attorney reminders and in-app notification inbox.',
    category: 'Attorney workspace',
    defaultRoles: ['ATTORNEY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'attorney_billing',
    label: 'Attorney Billing',
    description: 'Use attorney billing, payment requests, and invoice review.',
    category: 'Attorney workspace',
    defaultRoles: ['ATTORNEY', 'ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'attorney_matching_auto',
    label: 'Automatic Attorney Matching',
    description: 'Run automatic attorney matching on staff case queues.',
    category: 'Attorney matching',
    defaultRoles: ['ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'attorney_matching_manual',
    label: 'Manual Attorney Matching',
    description: 'Create manual attorney matches and override automatic routing.',
    category: 'Attorney matching',
    defaultRoles: ['ADMIN', 'OPS', 'AGENT'],
  },
  {
    key: 'admin_database',
    label: 'Admin Database Tools',
    description: 'Use admin-side bulk upload and database operations.',
    category: 'Admin',
    defaultRoles: ['ADMIN', 'OPS', 'AGENT'],
  },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  description: string
  category: string
  defaultRoles: readonly PlatformRole[]
}>

export type PlatformFeatureKey = (typeof PLATFORM_FEATURES)[number]['key']

export function getPlatformFeatureDefinition(featureKey: string) {
  return PLATFORM_FEATURES.find((feature) => feature.key === featureKey) ?? null
}

export function listPlatformFeatureCategories() {
  return [...new Set(PLATFORM_FEATURES.map((feature) => feature.category))]
}

export function isFeatureDefaultEnabledForRole(role: PlatformRole, featureKey: PlatformFeatureKey) {
  const feature = getPlatformFeatureDefinition(featureKey)
  if (!feature) return false
  return feature.defaultRoles.some((defaultRole) => defaultRole === role)
}

export function isKnownPlatformFeature(featureKey: string): featureKey is PlatformFeatureKey {
  return PLATFORM_FEATURES.some((feature) => feature.key === featureKey)
}
