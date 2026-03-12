type MetadataRecord = Record<string, unknown>

type CaseDisplayCarrier = {
  metadata?: MetadataRecord | null
  violation_date?: string | null
  court_case_number?: string | null
  attorney_update_date?: string | null
  submitter_email?: string | null
  submitter_user_id?: string | null
  owner_id?: string | null
  driver_name?: string | null
  first_name?: string | null
  last_name?: string | null
  driver_first_name?: string | null
  driver_last_name?: string | null
  full_name?: string | null
}

export function getCaseMetadataRecord(caseRow: CaseDisplayCarrier) {
  const raw = caseRow.metadata
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {} as MetadataRecord
  return raw as MetadataRecord
}

export function getCaseDisplayDriverName(caseRow: CaseDisplayCarrier) {
  const directRow = [
    caseRow.driver_name,
    caseRow.full_name,
  ]
    .map((value) => String(value ?? '').trim())
    .find(Boolean)
  if (directRow) return directRow

  const rowFirst = String(caseRow.first_name ?? caseRow.driver_first_name ?? '').trim()
  const rowLast = String(caseRow.last_name ?? caseRow.driver_last_name ?? '').trim()
  const rowFullName = `${rowFirst} ${rowLast}`.trim()
  if (rowFullName) return rowFullName

  const metadata = getCaseMetadataRecord(caseRow)
  const direct = [
    metadata['driver_name'],
    metadata['client_name'],
    metadata['full_name'],
    metadata['submitter_name'],
  ]
    .map((value) => String(value ?? '').trim())
    .find(Boolean)
  if (direct) return direct

  const first = String(
    metadata['first_name'] ??
      metadata['driver_first_name'] ??
      metadata['client_first_name'] ??
      metadata['submitter_first_name'] ??
      ''
  ).trim()
  const last = String(
    metadata['last_name'] ??
      metadata['driver_last_name'] ??
      metadata['client_last_name'] ??
      metadata['submitter_last_name'] ??
      ''
  ).trim()
  const fullName = `${first} ${last}`.trim()
  return fullName || '-'
}

export function getCaseSubmitterName(caseRow: CaseDisplayCarrier) {
  const metadata = getCaseMetadataRecord(caseRow)
  const direct = [
    metadata['submitter_name'],
    metadata['contact_name'],
    metadata['driver_name'],
    metadata['client_name'],
    metadata['full_name'],
  ]
    .map((value) => String(value ?? '').trim())
    .find(Boolean)
  if (direct) return direct

  const first = String(
    metadata['submitter_first_name'] ??
      metadata['first_name'] ??
      metadata['driver_first_name'] ??
      metadata['client_first_name'] ??
      ''
  ).trim()
  const last = String(
    metadata['submitter_last_name'] ??
      metadata['last_name'] ??
      metadata['driver_last_name'] ??
      metadata['client_last_name'] ??
      ''
  ).trim()
  const fullName = `${first} ${last}`.trim()
  return fullName || null
}

export function getCaseSubmitterEmail(caseRow: CaseDisplayCarrier) {
  const metadata = getCaseMetadataRecord(caseRow)
  const direct = [
    caseRow.submitter_email,
    metadata['submitter_email'],
    metadata['email'],
    metadata['driver_email'],
    metadata['client_email'],
    metadata['contact_email'],
  ]
    .map((value) => String(value ?? '').trim())
    .find(Boolean)
  return direct || null
}

export function getCaseSubmitterPhone(caseRow: CaseDisplayCarrier) {
  const metadata = getCaseMetadataRecord(caseRow)
  const direct = [
    metadata['submitter_phone'],
    metadata['phone_number'],
    metadata['phone'],
    metadata['driver_phone'],
    metadata['client_phone'],
    metadata['contact_phone'],
  ]
    .map((value) => String(value ?? '').trim())
    .find(Boolean)
  return direct || null
}

export function getCaseSubmittedByRole(caseRow: CaseDisplayCarrier) {
  const metadata = getCaseMetadataRecord(caseRow)
  const direct = String(metadata['submitted_by_role'] ?? metadata['uploader_role'] ?? '')
    .trim()
    .toUpperCase()
  return direct || null
}

export function getCaseSubmittedByUserId(caseRow: CaseDisplayCarrier) {
  const metadata = getCaseMetadataRecord(caseRow)
  const direct = String(metadata['submitted_by_user_id'] ?? caseRow.submitter_user_id ?? caseRow.owner_id ?? '').trim()
  return direct || null
}

export function getCaseViolationDate(caseRow: CaseDisplayCarrier) {
  const direct = String(caseRow.violation_date ?? '').trim()
  if (direct) return direct

  const metadata = getCaseMetadataRecord(caseRow)
  return (
    String(
      metadata['violation_date'] ??
        metadata['date_of_violation'] ??
        metadata['ticket_violation_date'] ??
        metadata['violationDate'] ??
        ''
    ).trim() || null
  )
}

export function getCaseCourtCaseNumber(caseRow: CaseDisplayCarrier) {
  const direct = String(caseRow.court_case_number ?? '').trim()
  if (direct) return direct

  const metadata = getCaseMetadataRecord(caseRow)
  return (
    String(
      metadata['court_case_number'] ??
        metadata['case_ref'] ??
        metadata['case_reference'] ??
        metadata['courtCaseNumber'] ??
        ''
    ).trim() || null
  )
}

export function getCaseAttorneyUpdateDate(caseRow: CaseDisplayCarrier) {
  const direct = String(caseRow.attorney_update_date ?? '').trim()
  if (direct) return direct

  const metadata = getCaseMetadataRecord(caseRow)
  return (
    String(
      metadata['attorney_update_date'] ??
        metadata['attorney_case_updated_at'] ??
        metadata['attorneyUpdateDate'] ??
        ''
    ).trim() || null
  )
}
