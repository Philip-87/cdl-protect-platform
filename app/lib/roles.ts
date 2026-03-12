export const PLATFORM_ROLES = [
  'NONE',
  'DRIVER',
  'FLEET',
  'AGENCY',
  'ATTORNEY',
  'ADMIN',
  'OPS',
  'AGENT',
] as const

export type PlatformRole = (typeof PLATFORM_ROLES)[number]

export function normalizePlatformRole(value: string | null | undefined): PlatformRole {
  const upper = String(value ?? 'NONE')
    .trim()
    .toUpperCase()

  if (PLATFORM_ROLES.includes(upper as PlatformRole)) {
    return upper as PlatformRole
  }

  return 'NONE'
}

export function isStaffRole(role: PlatformRole) {
  return role === 'ADMIN' || role === 'OPS' || role === 'AGENT'
}

export function isAgencyRole(role: PlatformRole) {
  return role === 'AGENCY'
}

export function isFleetRole(role: PlatformRole) {
  return role === 'FLEET'
}

export function isDriverRole(role: PlatformRole) {
  return role === 'DRIVER'
}

export function isAttorneyRole(role: PlatformRole) {
  return role === 'ATTORNEY'
}

export function roleHasFleetWorkspace(role: PlatformRole) {
  return isStaffRole(role) || isAgencyRole(role) || isFleetRole(role)
}

export function roleCanCreateFleet(role: PlatformRole) {
  return roleHasFleetWorkspace(role)
}

export function roleCanInvite(role: PlatformRole) {
  return roleHasFleetWorkspace(role)
}
