-- Attorney matching + outreach + quote + LawPay flow
-- Safe to run multiple times.

create extension if not exists pgcrypto;

alter table public.cases add column if not exists submitter_email text;
alter table public.cases add column if not exists submitter_user_id uuid references auth.users (id) on delete set null;
alter table public.cases add column if not exists ocr_text text;
alter table public.cases add column if not exists court_lat numeric(10,7);
alter table public.cases add column if not exists court_lng numeric(10,7);

alter table public.cases drop constraint if exists cases_status_check;
alter table public.cases add constraint cases_status_check
check (
  status::text in (
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
    'UNABLE_TO_SERVICE'
  )
);

alter table if exists public.case_status_transition_rules
  drop constraint if exists case_status_transition_rules_from_status_check;
alter table if exists public.case_status_transition_rules
  add constraint case_status_transition_rules_from_status_check
  check (
    from_status in (
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
      'UNABLE_TO_SERVICE'
    )
  );

alter table if exists public.case_status_transition_rules
  drop constraint if exists case_status_transition_rules_to_status_check;
alter table if exists public.case_status_transition_rules
  add constraint case_status_transition_rules_to_status_check
  check (
    to_status in (
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
      'UNABLE_TO_SERVICE'
    )
  );

insert into public.case_status_transition_rules (actor_scope, from_status, to_status, is_enabled)
values
  ('STAFF', 'ATTORNEY_MATCHING', 'AWAITING_PAYMENT', true),
  ('STAFF', 'ATTORNEY_ACCEPTED', 'AWAITING_PAYMENT', true),
  ('STAFF', 'AWAITING_PAYMENT', 'PAID', true),
  ('STAFF', 'PAID', 'IN_PROGRESS', true),
  ('AGENCY_FLEET', 'ATTORNEY_MATCHING', 'AWAITING_PAYMENT', true),
  ('AGENCY_FLEET', 'ATTORNEY_ACCEPTED', 'AWAITING_PAYMENT', true),
  ('ATTORNEY', 'ATTORNEY_ACCEPTED', 'AWAITING_PAYMENT', true),
  ('ATTORNEY', 'PAID', 'IN_PROGRESS', true)
on conflict (actor_scope, from_status, to_status)
do update set is_enabled = excluded.is_enabled;

create table if not exists public.attorney_directory (
  id uuid primary key default gen_random_uuid(),
  import_key text,
  name text,
  email text not null,
  phone text,
  state text not null,
  address text,
  lat numeric(10,7),
  lng numeric(10,7),
  is_statewide boolean not null default false,
  counties jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_attorney_directory_import_key
  on public.attorney_directory (import_key)
  where import_key is not null;
create unique index if not exists idx_attorney_directory_email_state
  on public.attorney_directory (lower(email), state);
create index if not exists idx_attorney_directory_state on public.attorney_directory (state);
create index if not exists idx_attorney_directory_lat_lng on public.attorney_directory (lat, lng);
create index if not exists idx_attorney_directory_statewide on public.attorney_directory (state, is_statewide);

create table if not exists public.attorney_pricing (
  id uuid primary key default gen_random_uuid(),
  law_firm_org_id uuid not null references public.attorney_firms (id) on delete cascade,
  state text not null,
  county text not null,
  cdl_fee_cents integer not null,
  non_cdl_fee_cents integer not null,
  is_active boolean not null default true,
  source text not null default 'ONBOARDING',
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (law_firm_org_id, state, county)
);

alter table public.attorney_pricing drop constraint if exists attorney_pricing_cdl_fee_check;
alter table public.attorney_pricing add constraint attorney_pricing_cdl_fee_check check (cdl_fee_cents > 0);
alter table public.attorney_pricing drop constraint if exists attorney_pricing_non_cdl_fee_check;
alter table public.attorney_pricing add constraint attorney_pricing_non_cdl_fee_check check (non_cdl_fee_cents > 0);

create index if not exists idx_attorney_pricing_lookup
  on public.attorney_pricing (state, county, is_active);

create table if not exists public.attorney_outreach (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  directory_attorney_id uuid references public.attorney_directory (id) on delete set null,
  email text not null,
  token_hash text not null,
  token_expires_at timestamptz not null,
  status text not null default 'PENDING',
  fee_cents integer,
  deny_reason text,
  responded_at timestamptz,
  response_ip text,
  response_user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.attorney_outreach drop constraint if exists attorney_outreach_status_check;
alter table public.attorney_outreach add constraint attorney_outreach_status_check
check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'));

create unique index if not exists idx_attorney_outreach_token_hash on public.attorney_outreach (token_hash);
create index if not exists idx_attorney_outreach_case_status on public.attorney_outreach (case_id, status, created_at desc);
create index if not exists idx_attorney_outreach_email_status on public.attorney_outreach (lower(email), status);

create table if not exists public.case_quotes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  law_firm_org_id uuid not null references public.attorney_firms (id) on delete cascade,
  attorney_fee_cents integer not null,
  platform_fee_cents integer not null default 10000,
  total_cents integer generated always as (attorney_fee_cents + platform_fee_cents) stored,
  status text not null default 'OPEN',
  quote_source text not null default 'MATCHING',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.case_quotes drop constraint if exists case_quotes_status_check;
alter table public.case_quotes add constraint case_quotes_status_check
check (status in ('OPEN', 'AWAITING_PAYMENT', 'PAID', 'VOID', 'EXPIRED'));

alter table public.case_quotes drop constraint if exists case_quotes_attorney_fee_check;
alter table public.case_quotes add constraint case_quotes_attorney_fee_check check (attorney_fee_cents > 0);
alter table public.case_quotes drop constraint if exists case_quotes_platform_fee_check;
alter table public.case_quotes add constraint case_quotes_platform_fee_check check (platform_fee_cents >= 0);

create unique index if not exists idx_case_quotes_case_open
  on public.case_quotes (case_id)
  where status in ('OPEN', 'AWAITING_PAYMENT');
create index if not exists idx_case_quotes_firm on public.case_quotes (law_firm_org_id, created_at desc);

create table if not exists public.case_payments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.case_quotes (id) on delete cascade,
  case_id uuid not null references public.cases (id) on delete cascade,
  provider text not null default 'LAWPAY',
  provider_charge_id text,
  provider_status text not null,
  amount_cents integer not null,
  method_type text,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_case_payments_provider_charge
  on public.case_payments (provider, provider_charge_id)
  where provider_charge_id is not null;
create index if not exists idx_case_payments_quote on public.case_payments (quote_id, created_at desc);
create index if not exists idx_case_payments_case on public.case_payments (case_id, created_at desc);

alter table public.attorney_directory enable row level security;
alter table public.attorney_pricing enable row level security;
alter table public.attorney_outreach enable row level security;
alter table public.case_quotes enable row level security;
alter table public.case_payments enable row level security;

drop policy if exists "attorney_directory_staff_only" on public.attorney_directory;
create policy "attorney_directory_staff_only"
on public.attorney_directory
for all
to authenticated
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

drop policy if exists "attorney_pricing_read_scope" on public.attorney_pricing;
create policy "attorney_pricing_read_scope"
on public.attorney_pricing
for select
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.user_id = auth.uid()
      and afm.firm_id = attorney_pricing.law_firm_org_id
  )
);

drop policy if exists "attorney_pricing_manage_staff" on public.attorney_pricing;
create policy "attorney_pricing_manage_staff"
on public.attorney_pricing
for all
to authenticated
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

drop policy if exists "attorney_outreach_staff_only" on public.attorney_outreach;
create policy "attorney_outreach_staff_only"
on public.attorney_outreach
for all
to authenticated
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

drop policy if exists "case_quotes_read_scope" on public.case_quotes;
create policy "case_quotes_read_scope"
on public.case_quotes
for select
to authenticated
using (public.can_access_case(case_quotes.case_id));

drop policy if exists "case_quotes_manage_staff" on public.case_quotes;
create policy "case_quotes_manage_staff"
on public.case_quotes
for all
to authenticated
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

drop policy if exists "case_payments_read_scope" on public.case_payments;
create policy "case_payments_read_scope"
on public.case_payments
for select
to authenticated
using (public.can_access_case(case_payments.case_id));

drop policy if exists "case_payments_manage_staff" on public.case_payments;
create policy "case_payments_manage_staff"
on public.case_payments
for all
to authenticated
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

drop trigger if exists trg_attorney_directory_updated_at on public.attorney_directory;
create trigger trg_attorney_directory_updated_at
before update on public.attorney_directory
for each row
execute function public.set_updated_at();

drop trigger if exists trg_attorney_pricing_updated_at on public.attorney_pricing;
create trigger trg_attorney_pricing_updated_at
before update on public.attorney_pricing
for each row
execute function public.set_updated_at();

drop trigger if exists trg_attorney_outreach_updated_at on public.attorney_outreach;
create trigger trg_attorney_outreach_updated_at
before update on public.attorney_outreach
for each row
execute function public.set_updated_at();

drop trigger if exists trg_case_quotes_updated_at on public.case_quotes;
create trigger trg_case_quotes_updated_at
before update on public.case_quotes
for each row
execute function public.set_updated_at();

drop trigger if exists trg_case_payments_updated_at on public.case_payments;
create trigger trg_case_payments_updated_at
before update on public.case_payments
for each row
execute function public.set_updated_at();
