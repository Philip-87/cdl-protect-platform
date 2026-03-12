# PLATFORM V1 SPEC

Generated: 2026-03-03  
Repo: `c:\Users\Gocev\cdl-protect-platform`

## 1) Product Guardrails

- Multi-tenant safety is mandatory: no cross-tenant reads/writes.
- End-user data access must run through Supabase RLS with session-bound `auth.uid()`.
- Service role usage is restricted to:
  - Webhooks
  - Cron/worker jobs
  - Admin-only internal actions/scripts
- AI is case-scoped only, tool-restricted, and non-legal.
- Platform automates workflow execution; humans provide docs, accept work, and perform legal work.

## 2) Roles and Permissions Matrix

Legend: `R` = read, `W` = write, `M` = manage/admin action, `-` = no access.

| Domain | DRIVER | FLEET | AGENCY | ATTORNEY | OPS/AGENT | ADMIN |
|---|---|---|---|---|---|---|
| Own profile | R/W | R/W | R/W | R/W | R/W | R/W |
| Cases (own/scope) | R/W own | R/W fleet scope | R/W agency scope | R/W assigned/firm scope | R/W operational scope | R/W global |
| Cases (other tenants) | - | - | - | - | - | M (staff only) |
| Documents (case-scoped) | R/W own case | R/W scoped | R/W scoped | R/W scoped | R/W scoped | R/W global |
| Messages/tasks (case-scoped) | R/W own case | R/W scoped | R/W scoped | R/W scoped | R/W scoped | R/W global |
| Assignment workflow | - | view scoped | offer/reroute | accept/decline | manage exceptions | manage all |
| Payment requests | view/pay own | approve/pay consolidated | request/track | request | monitor/reconcile | manage all |
| Billing/invoices | own receipts | consolidated invoices | scoped finance view | scoped finance view | ops finance | full finance admin |
| Invites | limited (self/onboarding) | scoped team invites | scoped team invites | scoped case invites | ops invites | full invite control |
| County/firm imports | - | - | - | - | M | M |
| Automation controls | - | - | - | - | monitor + retry | full control |
| AI case assistant | case-scoped | case-scoped | case-scoped | case-scoped | case-scoped | case-scoped + policy audit |

### Authorization Source of Truth

- Primary: DB RLS (`can_access_case`, membership policies, role checks).
- Secondary: app-level role checks for UX and fast-fail.
- No end-user action should bypass RLS.

## 3) Case Lifecycle State Machine

Canonical statuses:

- `INTAKE_RECEIVED`
- `NEEDS_REVIEW`
- `ATTORNEY_MATCHING`
- `OFFERED_TO_ATTORNEY`
- `ATTORNEY_ACCEPTED`
- `CLIENT_DOCS_REQUIRED`
- `IN_PROGRESS`
- `COURT_PENDING`
- `AWAITING_DISPOSITION`
- `DISPOSITION_RECEIVED`
- `CLOSED`
- `CANCELLED`
- `UNABLE_TO_SERVICE`

### Allowed Transitions by Actor Class

| From | To | DRIVER | FLEET/AGENCY | ATTORNEY | OPS/AGENT | ADMIN |
|---|---|---|---|---|---|---|
| `INTAKE_RECEIVED` | `NEEDS_REVIEW` | - | W | - | W | W |
| `NEEDS_REVIEW` | `ATTORNEY_MATCHING` | - | W | - | W | W |
| `ATTORNEY_MATCHING` | `OFFERED_TO_ATTORNEY` | - | W | - | W | W |
| `OFFERED_TO_ATTORNEY` | `ATTORNEY_ACCEPTED` | - | - | W | W | W |
| `OFFERED_TO_ATTORNEY` | `ATTORNEY_MATCHING` | - | W | W (decline path) | W | W |
| `ATTORNEY_ACCEPTED` | `CLIENT_DOCS_REQUIRED` | - | W | W | W | W |
| `ATTORNEY_ACCEPTED` | `IN_PROGRESS` | - | W | W | W | W |
| `CLIENT_DOCS_REQUIRED` | `IN_PROGRESS` | - | W | W | W | W |
| `IN_PROGRESS` | `COURT_PENDING` | - | W | W | W | W |
| `COURT_PENDING` | `AWAITING_DISPOSITION` | - | W | W | W | W |
| `AWAITING_DISPOSITION` | `DISPOSITION_RECEIVED` | - | W | W | W | W |
| `DISPOSITION_RECEIVED` | `CLOSED` | - | W | W | W | W |
| Any non-terminal | `CANCELLED` | - | W | - | W | W |
| Any non-terminal | `UNABLE_TO_SERVICE` | - | W | - | W | W |

Rules:

- Terminal states: `CLOSED`, `CANCELLED`, `UNABLE_TO_SERVICE`.
- Transition enforcement must be DB-enforced (RPC/trigger/function).
- Role visibility can differ from status mutability.

## 4) Automation Model

Automation engine: Postgres-backed `job_queue` + worker with retries/backoff/dead-letter.

| Event | Trigger | Job | Retry Policy | SLA |
|---|---|---|---|---|
| OCR requested | document uploaded | `OCR_PROCESS_DOCUMENT` | exp backoff, max attempts, dead-letter | first attempt < 1 min |
| Offer stale | offer not accepted before expiry | `ESCALATE_UNACCEPTED_OFFER` | exp backoff | escalate at expiry + 5 min |
| Missing client docs | `CLIENT_DOCS_REQUIRED` + no upload by due window | `REMIND_CLIENT_DOCS` | exp backoff | reminder at 24h/72h cadence |
| Court approaching | court date window reached | `REMIND_COURT_DATE` | exp backoff | 7d/3d/1d reminders |
| Attorney update nudge | no progress update interval reached | `NUDGE_ATTORNEY_UPDATE` | exp backoff | every 48h until resolved |
| Payment request due | open payment request near due date | `REMIND_PAYMENT_DUE` | exp backoff | per due-date policy |

Audit requirement:

- Every job attempt writes to `job_runs` and `case_events`.
- Dead-letter jobs are visible in ops/admin exception queue.

## 5) Payment and Ledger Model

### Core Tables

- `payment_requests`
  - `id`, `case_id`, `requested_by`, `payer_role`, `amount_cents`, `currency`, `status`, `due_at`, `metadata`, timestamps
- `payments`
  - `id`, `payment_request_id`, `case_id`, `payer_user_id`, `provider` (`STRIPE`), `provider_payment_intent_id`, `amount_cents`, `status`, `captured_at`, timestamps
- `payment_events`
  - `id`, `provider`, `provider_event_id` (unique), `type`, `payload`, `received_at`, `processed_at`, `status`
- `case_financial_ledger`
  - `id`, `case_id`, `entry_type` (`DEBIT`,`CREDIT`,`FEE`,`REFUND`), `amount_cents`, `currency`, `source_table`, `source_id`, `description`, `occurred_at`
- `billing_groups` (fleet consolidated billing MVP)
  - `id`, `fleet_id`, `status`, `currency`, `total_cents`, `checkout_reference`, timestamps
- `billing_group_items`
  - `billing_group_id`, `payment_request_id`, `case_id`, `amount_cents`

### Payment Statuses

- Request: `OPEN`, `PENDING_CHECKOUT`, `PAID`, `PARTIALLY_PAID`, `VOID`, `EXPIRED`
- Payment: `REQUIRES_ACTION`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED`

### Flow

1. Attorney/ops creates `payment_request`.
2. Checkout session is created (case-level or fleet-group).
3. Webhook validates signature + idempotency (`provider_event_id` unique).
4. On settlement, write `payments`, `payment_events`, ledger entries.
5. Case financial summary updates (`paid_amount`, `balance_due`, `financial_status`).
6. Receipt artifact generated and linked.

## 6) Notifications Model

Table: `notifications`

- `id`, `user_id`, `case_id`, `type`, `title`, `body`, `read_at`, `metadata`, `created_at`

Sources:

- User actions (message received, docs requested, payment requested, offer accepted, disposition recorded)
- Automation jobs (reminders/escalations)
- Webhook-driven finance events (payment succeeded/failed/refund)

Delivery:

- In-app notification center is primary.
- Optional email channel per user preference and event type.

UX requirements:

- Global bell badge
- Inbox page with server pagination
- Case-local notification feed
- Mark one / mark all read

## 7) AI Case Agent (Strict Scope and Limits)

### Allowed Capabilities

- Summarize case timeline and current status
- List missing required artifacts
- Draft role-appropriate case messages
- Suggest next operational step from state machine
- Extract structured document fields (non-legal)

### Hard Limits

- Must not provide legal advice or legal strategy.
- Must include a disclaimer in UI and response metadata.
- Must be case-scoped (`case_id` required in every tool call).
- Must only call approved backend tools that enforce `can_access_case()`.
- No unrestricted DB querying and no free-chat data access.
- AI outputs are drafts by default; no auto-send without explicit user action.
- Exception: fixed-template automation reminders from job system.

### Required AI Endpoints

- `getCaseContext(caseId)`
- `draftMessage(caseId, recipientRole, intent)`
- `summarizeCase(caseId)`
- `extractFieldsFromDocument(caseId, documentId)`

## 8) UX Map by Role

### DRIVER

- Dashboard: my active/closed cases, payment actions, pending document requests
- Case workspace: timeline, upload docs, message attorney/ops, payment history
- Intake: guided minimal input + OCR prefill + progress clarity

### FLEET

- Fleet dashboard: portfolio, filters, driver-level breakdown, exception flags
- Consolidated billing: batch pay open requests, invoice export, payment status
- Driver management: invite/assign, visibility controls

### AGENCY

- Intake + routing command center
- Offer/assignment workflow queue
- SLA and stuck-case monitoring

### ATTORNEY

- Offers queue + accept/decline
- Assigned case workspace with checklist, timeline, uploads, message templates
- Payment request creation and financial visibility per case

### OPS/AGENT

- Automation health dashboard
- Exception queue (failed jobs, stale offers, overdue docs, webhook failures)
- Operational overrides with audit trails

### ADMIN

- Global controls: roles, invites, imports, policy verification, finance controls
- RLS/policy health checks and audit views
- System configuration (feature flags, templates, automation thresholds)

## 9) Non-Functional Requirements

- Security: RLS regression tests mandatory for all core tables and critical RPCs.
- Reliability: idempotent webhooks/jobs, explicit retries, dead-letter handling.
- Observability: structured events, per-case audit trail, job run logs.
- Accessibility: labeled forms, keyboard support, focus states, aria basics.
- Performance: server-side pagination, bounded list queries, index-backed filters.

