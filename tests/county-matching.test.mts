import test from 'node:test'
import assert from 'node:assert/strict'
import { countyNameAliases, countyNamesOverlap, normalizeCountyName } from '../app/lib/matching/county.ts'

test('normalizeCountyName collapses suffix variants to a canonical county name', () => {
  assert.equal(normalizeCountyName('Morgan County'), 'MORGAN')
  assert.equal(normalizeCountyName('St. Mary Parish'), 'ST MARY')
  assert.equal(normalizeCountyName('Juneau City and Borough'), 'JUNEAU')
})

test('county aliases overlap across county suffix variants', () => {
  assert.equal(countyNamesOverlap('Morgan', 'Morgan County'), true)
  assert.equal(countyNamesOverlap('St. Mary Parish', 'St Mary'), true)
  assert.equal(countyNamesOverlap('Jefferson', 'Morgan County'), false)
})

test('countyNameAliases includes both canonical and suffixed variants for database lookups', () => {
  const aliases = countyNameAliases('Morgan')
  assert.ok(aliases.includes('MORGAN'))
  assert.ok(aliases.includes('MORGAN COUNTY'))
})
