alter table public.cases
  add column if not exists pricing_available boolean,
  add column if not exists attorney_fee_cents integer,
  add column if not exists platform_fee_cents integer,
  add column if not exists total_price_cents integer,
  add column if not exists show_paid_pricing_to_fleet_driver boolean not null default false,
  add column if not exists keep_agency_as_primary_contact boolean not null default false,
  add column if not exists primary_contact_type text not null default 'SUBMITTER',
  add column if not exists quote_requested_at timestamptz,
  add column if not exists quote_received_at timestamptz,
  add column if not exists attorney_outreach_started_at timestamptz,
  add column if not exists payment_flow_status text not null default 'INTAKE_SUBMITTED',
  add column if not exists payment_request_sent_at timestamptz,
  add column if not exists quote_source_attorney_email text;

alter table public.cases drop constraint if exists cases_primary_contact_type_check;
alter table public.cases add constraint cases_primary_contact_type_check
check (primary_contact_type in ('SUBMITTER', 'AGENCY'));

create index if not exists idx_cases_payment_flow_status
  on public.cases (payment_flow_status, updated_at desc);

create index if not exists idx_cases_quote_requested_at
  on public.cases (quote_requested_at desc nulls last);

alter table public.attorney_outreach
  add column if not exists law_firm_org_id uuid references public.attorney_firms (id) on delete set null,
  add column if not exists outreach_type text not null default 'QUOTE_REQUEST',
  add column if not exists sent_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists quoted_at timestamptz,
  add column if not exists quoted_amount_cents integer,
  add column if not exists attorney_notes text;

update public.attorney_outreach
set sent_at = coalesce(sent_at, created_at)
where sent_at is null;

alter table public.attorney_outreach drop constraint if exists attorney_outreach_status_check;
alter table public.attorney_outreach add constraint attorney_outreach_status_check
check (status in ('PENDING', 'ACCEPTED', 'QUOTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'));

alter table public.attorney_outreach drop constraint if exists attorney_outreach_type_check;
alter table public.attorney_outreach add constraint attorney_outreach_type_check
check (outreach_type in ('QUOTE_REQUEST', 'PRICED_MATCH'));

alter table public.attorney_outreach drop constraint if exists attorney_outreach_quoted_amount_check;
alter table public.attorney_outreach add constraint attorney_outreach_quoted_amount_check
check (quoted_amount_cents is null or quoted_amount_cents > 0);

create index if not exists idx_attorney_outreach_type_status
  on public.attorney_outreach (case_id, outreach_type, status, created_at desc);

create index if not exists idx_attorney_outreach_firm
  on public.attorney_outreach (law_firm_org_id, created_at desc);

alter table public.case_quotes
  add column if not exists outreach_id uuid references public.attorney_outreach (id) on delete set null,
  add column if not exists notes text,
  add column if not exists submitted_at timestamptz not null default now();

alter table public.case_quotes alter column platform_fee_cents set default 20000;

create index if not exists idx_case_quotes_outreach
  on public.case_quotes (outreach_id, submitted_at desc);

alter table public.payment_requests
  add column if not exists quote_id uuid references public.case_quotes (id) on delete set null,
  add column if not exists requested_to_user_id uuid references auth.users (id) on delete set null,
  add column if not exists request_email text,
  add column if not exists source_type text not null default 'DIRECT_REQUEST',
  add column if not exists sent_at timestamptz;

alter table public.payment_requests drop constraint if exists payment_requests_source_type_check;
alter table public.payment_requests add constraint payment_requests_source_type_check
check (source_type in ('DIRECT_PRICED', 'ATTORNEY_QUOTE', 'MANUAL_MATCH', 'DIRECT_REQUEST'));

create index if not exists idx_payment_requests_quote
  on public.payment_requests (quote_id, created_at desc);

create index if not exists idx_payment_requests_recipient
  on public.payment_requests (requested_to_user_id, created_at desc);
