import test from 'node:test'
import assert from 'node:assert/strict'
import { extractMissingColumnName } from '../app/lib/server/fleet-access.ts'

test('extracts missing column names from qualified Postgres errors', () => {
  assert.equal(extractMissingColumnName('column fleets.is_active does not exist'), 'is_active')
  assert.equal(extractMissingColumnName('column "fleets"."is_active" does not exist'), 'is_active')
  assert.equal(extractMissingColumnName("Could not find the 'is_active' column of 'fleets' in the schema cache"), 'is_active')
})
