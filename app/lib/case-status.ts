export const CASE_STATUSES = [
  'INTAKE_RECEIVED',
  'NEEDS_REVIEW',
  'ATTORNEY_MATCHING',
  'OFFERED_TO_ATTORNEY',
  'ATTORNEY_ACCEPTED',
  'AWAITING_PAYMENT',
  'PAID',
  'CLIENT_DOCS_REQUIRED',
  'IN_PROGRESS',
  'COURT_PENDING',
  'AWAITING_DISPOSITION',
  'DISPOSITION_RECEIVED',
  'CLOSED',
  'CANCELLED',
  'UNABLE_TO_SERVICE',
] as const

export type CaseStatus = (typeof CASE_STATUSES)[number]

export function isValidCaseStatus(value: string): value is CaseStatus {
  return CASE_STATUSES.includes(value as CaseStatus)
}

const ATTORNEY_HIDDEN_CASE_STATUSES = new Set<CaseStatus>([
  'ATTORNEY_MATCHING',
  'OFFERED_TO_ATTORNEY',
  'ATTORNEY_ACCEPTED',
  'CLIENT_DOCS_REQUIRED',
  'IN_PROGRESS',
])

export const ATTORNEY_CASE_STATUSES = CASE_STATUSES.filter(
  (status) => !ATTORNEY_HIDDEN_CASE_STATUSES.has(status)
) as readonly CaseStatus[]

export const ATTORNEY_WORKFLOW_STEPS = [
  'AC Agreement Sent',
  'AC Agreement Received',
  'Waiting for Ticket',
  'Filed Notice of Entry',
  'Waiting on Client Docs to Enter',
  'Offer Requested',
  'Continuance Requested',
  'Motion to Recall Warrant Requested',
  'Client Documents or Information Requested',
  'Offer Received',
  'Offer Delivered',
  'Guilty Plea Filed',
  'Withdrawal to Court',
  'Hired to Pay Court Fine',
  'Client Pays Court Fine',
  'Court Fine Paid',
  'Client or Court Action Required to Close Case',
  'Jury Trial Demand Filed With Court',
  'Closed - Amended Charge',
  'Closed - Amended Charge Fine',
  'Closed - Dismissed',
  'Closed - Guilty (No Amendments)',
] as const

export type AttorneyWorkflowStep = (typeof ATTORNEY_WORKFLOW_STEPS)[number]

export function isValidAttorneyWorkflowStep(value: string): value is AttorneyWorkflowStep {
  return ATTORNEY_WORKFLOW_STEPS.includes(value as AttorneyWorkflowStep)
}
