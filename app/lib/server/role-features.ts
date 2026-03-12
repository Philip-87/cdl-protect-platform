import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PLATFORM_FEATURES,
  getPlatformFeatureDefinition,
  isFeatureDefaultEnabledForRole,
  isKnownPlatformFeature,
  type PlatformFeatureKey,
} from '../features.ts'
import { type PlatformRole } from '../roles.ts'

export type RoleFeatureOverrideRow = {
  id: string
  role: PlatformRole
  feature_key: PlatformFeatureKey
  is_enabled: boolean
  updated_at: string
}

export function isMissingRoleFeatureSchema(message: string) {
  return /relation .* does not exist/i.test(message) || /schema cache/i.test(message) || /column .* does not exist/i.test(message)
}

export async function loadRoleFeatureOverrides(client: Pick<SupabaseClient, 'from'>) {
  const res = await client
    .from('platform_role_feature_overrides')
    .select('id, role, feature_key, is_enabled, updated_at')
    .order('role', { ascending: true })
    .order('feature_key', { ascending: true })

  if (res.error) {
    if (isMissingRoleFeatureSchema(res.error.message)) {
      return {
        overrides: [] as RoleFeatureOverrideRow[],
        migrationPending: true,
        error: null as string | null,
      }
    }

    return {
      overrides: [] as RoleFeatureOverrideRow[],
      migrationPending: false,
      error: res.error.message,
    }
  }

  const overrides = ((res.data ?? []) as Array<{ id: string; role: string; feature_key: string; is_enabled: boolean; updated_at: string }>)
    .filter(
      (
        row
      ): row is { id: string; role: string; feature_key: PlatformFeatureKey; is_enabled: boolean; updated_at: string } =>
        isKnownPlatformFeature(row.feature_key)
    )
    .map((row) => ({
      id: row.id,
      role: row.role as PlatformRole,
      feature_key: row.feature_key,
      is_enabled: row.is_enabled,
      updated_at: row.updated_at,
    }))

  return {
    overrides,
    migrationPending: false,
    error: null as string | null,
  }
}

export function getEffectiveFeatureMapForRole(role: PlatformRole, overrides: RoleFeatureOverrideRow[]) {
  const overrideMap = new Map(
    overrides.filter((row) => row.role === role).map((row) => [row.feature_key, row.is_enabled] as const)
  )

  return Object.fromEntries(
    PLATFORM_FEATURES.map((feature) => [
      feature.key,
      overrideMap.has(feature.key)
        ? Boolean(overrideMap.get(feature.key))
        : isFeatureDefaultEnabledForRole(role, feature.key),
    ])
  ) as Record<PlatformFeatureKey, boolean>
}

export function getEnabledFeaturesForRole(role: PlatformRole, overrides: RoleFeatureOverrideRow[]) {
  const featureMap = getEffectiveFeatureMapForRole(role, overrides)
  return PLATFORM_FEATURES.filter((feature) => featureMap[feature.key]).map((feature) => feature.key)
}

export function hasPlatformFeature(
  enabledFeatures: readonly string[] | null | undefined,
  featureKey: PlatformFeatureKey
) {
  return Array.isArray(enabledFeatures) && enabledFeatures.includes(featureKey)
}

export function groupFeaturesByCategory() {
  const grouped = new Map<string, Array<(typeof PLATFORM_FEATURES)[number]>>()
  for (const feature of PLATFORM_FEATURES) {
    const bucket = grouped.get(feature.category) ?? []
    bucket.push(feature)
    grouped.set(feature.category, bucket)
  }
  return grouped
}

export function getFeatureLabel(featureKey: string) {
  return getPlatformFeatureDefinition(featureKey)?.label ?? featureKey
}
