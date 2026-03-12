import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getCaseSubmittedByRole,
  getCaseSubmittedByUserId,
  getCaseSubmitterEmail,
  getCaseSubmitterName,
  getCaseSubmitterPhone,
} from '../app/lib/cases/display'

test('submitter helpers read explicit submitter fields first', () => {
  const caseRow = {
    submitter_email: 'submitter@example.com',
    submitter_user_id: 'user-123',
    owner_id: 'owner-123',
    metadata: {
      submitter_name: 'Jordan Driver',
      submitter_phone: '555-111-2222',
      submitted_by_role: 'AGENCY',
      submitted_by_user_id: 'user-123',
    },
  }

  assert.equal(getCaseSubmitterName(caseRow), 'Jordan Driver')
  assert.equal(getCaseSubmitterEmail(caseRow), 'submitter@example.com')
  assert.equal(getCaseSubmitterPhone(caseRow), '555-111-2222')
  assert.equal(getCaseSubmittedByRole(caseRow), 'AGENCY')
  assert.equal(getCaseSubmittedByUserId(caseRow), 'user-123')
})

test('submitter helpers fall back to intake metadata when direct fields are missing', () => {
  const caseRow = {
    owner_id: 'owner-456',
    metadata: {
      first_name: 'Taylor',
      last_name: 'Fleet',
      email: 'fleet@example.com',
      phone_number: '555-333-4444',
    },
  }

  assert.equal(getCaseSubmitterName(caseRow), 'Taylor Fleet')
  assert.equal(getCaseSubmitterEmail(caseRow), 'fleet@example.com')
  assert.equal(getCaseSubmitterPhone(caseRow), '555-333-4444')
  assert.equal(getCaseSubmittedByRole(caseRow), null)
  assert.equal(getCaseSubmittedByUserId(caseRow), 'owner-456')
})
