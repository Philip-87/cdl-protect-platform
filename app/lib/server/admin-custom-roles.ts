import type { SupabaseClient } from '@supabase/supabase-js'

export type AdminCustomRoleRow = {
  id: string
  name: string
  slug: string
  description: string | null
  base_role: string | null
  capability_codes: string[] | null
  is_active: boolean | null
  created_at: string
}

export type AdminCustomRoleAssignmentRow = {
  id: string
  custom_role_id: string
  profile_id: string
  assigned_by: string | null
  created_at: string
}

export function isMissingAdminRoleSchema(message: string) {
  return /relation .* does not exist/i.test(message) || /schema cache/i.test(message) || /column .* does not exist/i.test(message)
}

export function slugifyCustomRole(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function loadAdminCustomRoles(client: Pick<SupabaseClient, 'from'>) {
  const rolesRes = await client
    .from('platform_custom_roles')
    .select('id, name, slug, description, base_role, capability_codes, is_active, created_at')
    .order('name', { ascending: true })

  if (rolesRes.error) {
    if (isMissingAdminRoleSchema(rolesRes.error.message)) {
      return {
        roles: [] as AdminCustomRoleRow[],
        assignments: [] as AdminCustomRoleAssignmentRow[],
        migrationPending: true,
        error: null as string | null,
      }
    }

    return {
      roles: [] as AdminCustomRoleRow[],
      assignments: [] as AdminCustomRoleAssignmentRow[],
      migrationPending: false,
      error: rolesRes.error.message,
    }
  }

  const roles = (rolesRes.data ?? []) as AdminCustomRoleRow[]
  const roleIds = roles.map((role) => role.id)
  if (!roleIds.length) {
    return {
      roles,
      assignments: [] as AdminCustomRoleAssignmentRow[],
      migrationPending: false,
      error: null as string | null,
    }
  }

  const assignmentsRes = await client
    .from('platform_custom_role_assignments')
    .select('id, custom_role_id, profile_id, assigned_by, created_at')
    .in('custom_role_id', roleIds)

  if (assignmentsRes.error) {
    if (isMissingAdminRoleSchema(assignmentsRes.error.message)) {
      return {
        roles,
        assignments: [] as AdminCustomRoleAssignmentRow[],
        migrationPending: true,
        error: null as string | null,
      }
    }

    return {
      roles,
      assignments: [] as AdminCustomRoleAssignmentRow[],
      migrationPending: false,
      error: assignmentsRes.error.message,
    }
  }

  return {
    roles,
    assignments: (assignmentsRes.data ?? []) as AdminCustomRoleAssignmentRow[],
    migrationPending: false,
    error: null as string | null,
  }
}
