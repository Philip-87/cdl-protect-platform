import test from 'node:test'
import assert from 'node:assert/strict'
import { isMissingAdminRoleSchema, slugifyCustomRole } from '../app/lib/server/admin-custom-roles.ts'

test('slugifyCustomRole normalizes names and capability tokens', () => {
  assert.equal(slugifyCustomRole('Claims Supervisor'), 'claims-supervisor')
  assert.equal(slugifyCustomRole(' Billing / Review '), 'billing-review')
})

test('isMissingAdminRoleSchema recognizes missing relation and schema-cache errors', () => {
  assert.equal(isMissingAdminRoleSchema('relation "platform_custom_roles" does not exist'), true)
  assert.equal(isMissingAdminRoleSchema("Could not find the 'capability_codes' column in the schema cache"), true)
  assert.equal(isMissingAdminRoleSchema('duplicate key value violates unique constraint'), false)
})
