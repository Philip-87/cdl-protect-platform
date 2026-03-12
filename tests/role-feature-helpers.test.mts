import test from 'node:test'
import assert from 'node:assert/strict'
import { PLATFORM_FEATURES } from '../app/lib/features.ts'
import { getEffectiveFeatureMapForRole, isMissingRoleFeatureSchema } from '../app/lib/server/role-features.ts'

test('role feature helper recognizes missing schema errors', () => {
  assert.equal(isMissingRoleFeatureSchema('relation "platform_role_feature_overrides" does not exist'), true)
  assert.equal(isMissingRoleFeatureSchema("Could not find the 'feature_key' column in the schema cache"), true)
})

test('role feature helper applies overrides on top of defaults', () => {
  const featureMap = getEffectiveFeatureMapForRole('ATTORNEY', [
    {
      id: '1',
      role: 'ATTORNEY',
      feature_key: 'attorney_calendar',
      is_enabled: false,
      updated_at: new Date().toISOString(),
    },
    {
      id: '2',
      role: 'ATTORNEY',
      feature_key: 'csv_imports',
      is_enabled: true,
      updated_at: new Date().toISOString(),
    },
  ])

  assert.equal(featureMap.attorney_calendar, false)
  assert.equal(featureMap.csv_imports, true)
  assert.equal(featureMap.cases_workspace, true)
  assert.equal(Object.keys(featureMap).length, PLATFORM_FEATURES.length)
})
