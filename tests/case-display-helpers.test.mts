import test from 'node:test'
import assert from 'node:assert/strict'
import { getCaseAttorneyUpdateDate, getCaseCourtCaseNumber, getCaseDisplayDriverName, getCaseViolationDate } from '../app/lib/cases/display.ts'

test('case display helpers prefer explicit columns and fall back to metadata', () => {
  const row = {
    violation_date: null,
    court_case_number: '',
    attorney_update_date: null,
    metadata: {
      first_name: 'Vaska',
      last_name: 'Safety',
      violation_date: '2026-01-14',
      court_case_number: '2026-TR-1001',
      attorney_update_date: '2026-02-20',
    },
  }

  assert.equal(getCaseDisplayDriverName(row), 'Vaska Safety')
  assert.equal(getCaseViolationDate(row), '2026-01-14')
  assert.equal(getCaseCourtCaseNumber(row), '2026-TR-1001')
  assert.equal(getCaseAttorneyUpdateDate(row), '2026-02-20')
})

test('case display helpers use direct case columns when available', () => {
  const row = {
    violation_date: '2026-01-10',
    court_case_number: 'COL-55',
    attorney_update_date: '2026-02-18',
    metadata: {
      driver_name: 'Wrong Name',
      violation_date: '2026-01-12',
      court_case_number: 'META-1',
      attorney_update_date: '2026-02-19',
    },
  }

  assert.equal(getCaseDisplayDriverName(row), 'Wrong Name')
  assert.equal(getCaseViolationDate(row), '2026-01-10')
  assert.equal(getCaseCourtCaseNumber(row), 'COL-55')
  assert.equal(getCaseAttorneyUpdateDate(row), '2026-02-18')
})
