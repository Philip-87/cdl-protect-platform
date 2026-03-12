-- Phase 3: Stripe payments + financial ledger foundation.
-- Safe to run multiple times.

create extension if not exists pgcrypto;

create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete restrict,
  payer_role text not null,
  source text not null default 'DIRECT_CLIENT',
  amount_cents integer not null,
  currency text not null default 'usd',
  status text not null default 'OPEN',
  due_at timestamptz,
  paid_at timestamptz,
  provider text,
  provider_checkout_session_id text,
  provider_payment_intent_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_requests add column if not exists case_id uuid references public.cases (id) on delete cascade;
alter table public.payment_requests add column if not exists requested_by uuid references auth.users (id) on delete restrict;
alter table public.payment_requests add column if not exists payer_role text;
alter table public.payment_requests add column if not exists source text default 'DIRECT_CLIENT';
alter table public.payment_requests add column if not exists amount_cents integer;
alter table public.payment_requests add column if not exists currency text default 'usd';
alter table public.payment_requests add column if not exists status text default 'OPEN';
alter table public.payment_requests add column if not exists due_at timestamptz;
alter table public.payment_requests add column if not exists paid_at timestamptz;
alter table public.payment_requests add column if not exists provider text;
alter table public.payment_requests add column if not exists provider_checkout_session_id text;
alter table public.payment_requests add column if not exists provider_payment_intent_id text;
alter table public.payment_requests add column if not exists metadata jsonb default '{}'::jsonb;
alter table public.payment_requests add column if not exists created_at timestamptz default now();
alter table public.payment_requests add column if not exists updated_at timestamptz default now();

alter table public.payment_requests alter column case_id set not null;
alter table public.payment_requests alter column requested_by set not null;
alter table public.payment_requests alter column payer_role set not null;
alter table public.payment_requests alter column source set not null;
alter table public.payment_requests alter column amount_cents set not null;
alter table public.payment_requests alter column currency set not null;
alter table public.payment_requests alter column status set not null;
alter table public.payment_requests alter column metadata set not null;
alter table public.payment_requests alter column created_at set not null;
alter table public.payment_requests alter column updated_at set not null;

alter table public.payment_requests drop constraint if exists payment_requests_status_check;
alter table public.payment_requests add constraint payment_requests_status_check
check (status in ('OPEN', 'PENDING_CHECKOUT', 'PAID', 'PARTIALLY_PAID', 'VOID', 'EXPIRED'));

alter table public.payment_requests drop constraint if exists payment_requests_amount_check;
alter table public.payment_requests add constraint payment_requests_amount_check
check (amount_cents > 0);

create index if not exists idx_payment_requests_case on public.payment_requests (case_id, created_at desc);
create index if not exists idx_payment_requests_status on public.payment_requests (status, due_at);
create index if not exists idx_payment_requests_requested_by on public.payment_requests (requested_by, created_at desc);

drop trigger if exists trg_payment_requests_updated_at on public.payment_requests;
create trigger trg_payment_requests_updated_at
before update on public.payment_requests
for each row
execute function public.set_updated_at();

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid references public.payment_requests (id) on delete set null,
  case_id uuid not null references public.cases (id) on delete cascade,
  payer_user_id uuid references auth.users (id) on delete set null,
  provider text not null,
  provider_payment_intent_id text not null,
  provider_checkout_session_id text,
  amount_cents integer not null,
  currency text not null default 'usd',
  status text not null,
  captured_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payments add column if not exists payment_request_id uuid references public.payment_requests (id) on delete set null;
alter table public.payments add column if not exists case_id uuid references public.cases (id) on delete cascade;
alter table public.payments add column if not exists payer_user_id uuid references auth.users (id) on delete set null;
alter table public.payments add column if not exists provider text;
alter table public.payments add column if not exists provider_payment_intent_id text;
alter table public.payments add column if not exists provider_checkout_session_id text;
alter table public.payments add column if not exists amount_cents integer;
alter table public.payments add column if not exists currency text default 'usd';
alter table public.payments add column if not exists status text;
alter table public.payments add column if not exists captured_at timestamptz;
alter table public.payments add column if not exists metadata jsonb default '{}'::jsonb;
alter table public.payments add column if not exists created_at timestamptz default now();
alter table public.payments add column if not exists updated_at timestamptz default now();

alter table public.payments alter column case_id set not null;
alter table public.payments alter column provider set not null;
alter table public.payments alter column provider_payment_intent_id set not null;
alter table public.payments alter column amount_cents set not null;
alter table public.payments alter column currency set not null;
alter table public.payments alter column status set not null;
alter table public.payments alter column metadata set not null;
alter table public.payments alter column created_at set not null;
alter table public.payments alter column updated_at set not null;

alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check
check (status in ('REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'));

alter table public.payments drop constraint if exists payments_amount_check;
alter table public.payments add constraint payments_amount_check
check (amount_cents > 0);

create unique index if not exists idx_payments_provider_payment_intent
  on public.payments (provider, provider_payment_intent_id);
create index if not exists idx_payments_case on public.payments (case_id, created_at desc);
create index if not exists idx_payments_status on public.payments (status, created_at desc);

drop trigger if exists trg_payments_updated_at on public.payments;
create trigger trg_payments_updated_at
before update on public.payments
for each row
execute function public.set_updated_at();

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'RECEIVED',
  error_text text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.payment_events add column if not exists provider text;
alter table public.payment_events add column if not exists provider_event_id text;
alter table public.payment_events add column if not exists type text;
alter table public.payment_events add column if not exists payload jsonb default '{}'::jsonb;
alter table public.payment_events add column if not exists status text default 'RECEIVED';
alter table public.payment_events add column if not exists error_text text;
alter table public.payment_events add column if not exists received_at timestamptz default now();
alter table public.payment_events add column if not exists processed_at timestamptz;

alter table public.payment_events alter column provider set not null;
alter table public.payment_events alter column provider_event_id set not null;
alter table public.payment_events alter column type set not null;
alter table public.payment_events alter column payload set not null;
alter table public.payment_events alter column status set not null;
alter table public.payment_events alter column received_at set not null;

alter table public.payment_events drop constraint if exists payment_events_status_check;
alter table public.payment_events add constraint payment_events_status_check
check (status in ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED'));

create unique index if not exists idx_payment_events_provider_event
  on public.payment_events (provider, provider_event_id);
create index if not exists idx_payment_events_received on public.payment_events (received_at desc);

create table if not exists public.case_financial_ledger (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  entry_type text not null,
  amount_cents integer not null,
  currency text not null default 'usd',
  source_table text,
  source_id uuid,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.case_financial_ledger add column if not exists case_id uuid references public.cases (id) on delete cascade;
alter table public.case_financial_ledger add column if not exists entry_type text;
alter table public.case_financial_ledger add column if not exists amount_cents integer;
alter table public.case_financial_ledger add column if not exists currency text default 'usd';
alter table public.case_financial_ledger add column if not exists source_table text;
alter table public.case_financial_ledger add column if not exists source_id uuid;
alter table public.case_financial_ledger add column if not exists description text;
alter table public.case_financial_ledger add column if not exists metadata jsonb default '{}'::jsonb;
alter table public.case_financial_ledger add column if not exists occurred_at timestamptz default now();
alter table public.case_financial_ledger add column if not exists created_at timestamptz default now();

alter table public.case_financial_ledger alter column case_id set not null;
alter table public.case_financial_ledger alter column entry_type set not null;
alter table public.case_financial_ledger alter column amount_cents set not null;
alter table public.case_financial_ledger alter column currency set not null;
alter table public.case_financial_ledger alter column metadata set not null;
alter table public.case_financial_ledger alter column occurred_at set not null;
alter table public.case_financial_ledger alter column created_at set not null;

alter table public.case_financial_ledger drop constraint if exists case_financial_ledger_entry_type_check;
alter table public.case_financial_ledger add constraint case_financial_ledger_entry_type_check
check (entry_type in ('DEBIT', 'CREDIT', 'FEE', 'REFUND'));

create index if not exists idx_case_financial_ledger_case on public.case_financial_ledger (case_id, occurred_at desc);
create unique index if not exists idx_case_financial_ledger_source_entry
  on public.case_financial_ledger (entry_type, source_table, source_id)
  where source_id is not null;

create table if not exists public.billing_groups (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets (id) on delete cascade,
  status text not null default 'OPEN',
  currency text not null default 'usd',
  total_cents integer not null default 0,
  checkout_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.billing_groups add column if not exists fleet_id uuid references public.fleets (id) on delete cascade;
alter table public.billing_groups add column if not exists status text default 'OPEN';
alter table public.billing_groups add column if not exists currency text default 'usd';
alter table public.billing_groups add column if not exists total_cents integer default 0;
alter table public.billing_groups add column if not exists checkout_reference text;
alter table public.billing_groups add column if not exists metadata jsonb default '{}'::jsonb;
alter table public.billing_groups add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table public.billing_groups add column if not exists created_at timestamptz default now();
alter table public.billing_groups add column if not exists updated_at timestamptz default now();

alter table public.billing_groups alter column fleet_id set not null;
alter table public.billing_groups alter column status set not null;
alter table public.billing_groups alter column currency set not null;
alter table public.billing_groups alter column total_cents set not null;
alter table public.billing_groups alter column metadata set not null;
alter table public.billing_groups alter column created_at set not null;
alter table public.billing_groups alter column updated_at set not null;

alter table public.billing_groups drop constraint if exists billing_groups_status_check;
alter table public.billing_groups add constraint billing_groups_status_check
check (status in ('OPEN', 'PENDING_CHECKOUT', 'PAID', 'VOID'));

create index if not exists idx_billing_groups_fleet on public.billing_groups (fleet_id, created_at desc);

drop trigger if exists trg_billing_groups_updated_at on public.billing_groups;
create trigger trg_billing_groups_updated_at
before update on public.billing_groups
for each row
execute function public.set_updated_at();

create table if not exists public.billing_group_items (
  id uuid primary key default gen_random_uuid(),
  billing_group_id uuid not null references public.billing_groups (id) on delete cascade,
  payment_request_id uuid not null references public.payment_requests (id) on delete cascade,
  case_id uuid not null references public.cases (id) on delete cascade,
  amount_cents integer not null,
  created_at timestamptz not null default now(),
  unique (billing_group_id, payment_request_id)
);

alter table public.billing_group_items add column if not exists billing_group_id uuid references public.billing_groups (id) on delete cascade;
alter table public.billing_group_items add column if not exists payment_request_id uuid references public.payment_requests (id) on delete cascade;
alter table public.billing_group_items add column if not exists case_id uuid references public.cases (id) on delete cascade;
alter table public.billing_group_items add column if not exists amount_cents integer;
alter table public.billing_group_items add column if not exists created_at timestamptz default now();

alter table public.billing_group_items alter column billing_group_id set not null;
alter table public.billing_group_items alter column payment_request_id set not null;
alter table public.billing_group_items alter column case_id set not null;
alter table public.billing_group_items alter column amount_cents set not null;
alter table public.billing_group_items alter column created_at set not null;

alter table public.billing_group_items drop constraint if exists billing_group_items_amount_check;
alter table public.billing_group_items add constraint billing_group_items_amount_check
check (amount_cents > 0);

create index if not exists idx_billing_group_items_case on public.billing_group_items (case_id, created_at desc);
create index if not exists idx_billing_group_items_payment_request on public.billing_group_items (payment_request_id);

alter table public.cases add column if not exists paid_amount_cents integer not null default 0;
alter table public.cases add column if not exists balance_due_cents integer not null default 0;
alter table public.cases add column if not exists financial_status text not null default 'UNPAID';

alter table public.cases drop constraint if exists cases_financial_status_check;
alter table public.cases add constraint cases_financial_status_check
check (financial_status in ('UNPAID', 'PARTIALLY_PAID', 'PAID'));

create or replace function public.recalculate_case_financials(p_case_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  total_requested integer;
  total_paid integer;
  next_balance integer;
  next_status text;
begin
  select coalesce(sum(pr.amount_cents), 0)
  into total_requested
  from public.payment_requests pr
  where pr.case_id = p_case_id
    and pr.status <> 'VOID';

  select coalesce(sum(p.amount_cents), 0)
  into total_paid
  from public.payments p
  where p.case_id = p_case_id
    and p.status in ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED');

  next_balance := greatest(total_requested - total_paid, 0);
  next_status := case
    when total_paid <= 0 then 'UNPAID'
    when next_balance > 0 then 'PARTIALLY_PAID'
    else 'PAID'
  end;

  update public.cases c
  set paid_amount_cents = total_paid,
      balance_due_cents = next_balance,
      financial_status = next_status,
      updated_at = now()
  where c.id = p_case_id;
end;
$$;

revoke all on function public.recalculate_case_financials(uuid) from public;
grant execute on function public.recalculate_case_financials(uuid) to authenticated, service_role;

alter table public.payment_requests enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.case_financial_ledger enable row level security;
alter table public.billing_groups enable row level security;
alter table public.billing_group_items enable row level security;

drop policy if exists "payment_requests_select_scope" on public.payment_requests;
create policy "payment_requests_select_scope"
on public.payment_requests
for select
to authenticated
using (public.can_access_case(payment_requests.case_id));

drop policy if exists "payment_requests_insert_scope" on public.payment_requests;
create policy "payment_requests_insert_scope"
on public.payment_requests
for insert
to authenticated
with check (
  payment_requests.requested_by = auth.uid()
  and payment_requests.amount_cents > 0
  and public.can_access_case(payment_requests.case_id)
);

drop policy if exists "payment_requests_update_scope" on public.payment_requests;
create policy "payment_requests_update_scope"
on public.payment_requests
for update
to authenticated
using (
  public.can_access_case(payment_requests.case_id)
  and (
    payment_requests.requested_by = auth.uid()
    or public.is_staff(auth.uid())
  )
)
with check (
  public.can_access_case(payment_requests.case_id)
  and (
    payment_requests.requested_by = auth.uid()
    or public.is_staff(auth.uid())
  )
);

drop policy if exists "payments_select_scope" on public.payments;
create policy "payments_select_scope"
on public.payments
for select
to authenticated
using (public.can_access_case(payments.case_id));

drop policy if exists "payment_events_select_staff" on public.payment_events;
create policy "payment_events_select_staff"
on public.payment_events
for select
to authenticated
using (public.is_staff(auth.uid()));

drop policy if exists "case_financial_ledger_select_scope" on public.case_financial_ledger;
create policy "case_financial_ledger_select_scope"
on public.case_financial_ledger
for select
to authenticated
using (public.can_access_case(case_financial_ledger.case_id));

drop policy if exists "case_financial_ledger_insert_staff" on public.case_financial_ledger;
create policy "case_financial_ledger_insert_staff"
on public.case_financial_ledger
for insert
to authenticated
with check (
  public.is_staff(auth.uid())
  or public.can_access_case(case_financial_ledger.case_id)
);

drop policy if exists "billing_groups_select_scope" on public.billing_groups;
create policy "billing_groups_select_scope"
on public.billing_groups
for select
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.fleet_memberships fm
    where fm.user_id = auth.uid()
      and fm.fleet_id = billing_groups.fleet_id
  )
);

drop policy if exists "billing_groups_manage_scope" on public.billing_groups;
create policy "billing_groups_manage_scope"
on public.billing_groups
for all
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.fleet_memberships fm
    where fm.user_id = auth.uid()
      and fm.fleet_id = billing_groups.fleet_id
      and fm.role_in_fleet in ('fleet_admin', 'owner')
  )
)
with check (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.fleet_memberships fm
    where fm.user_id = auth.uid()
      and fm.fleet_id = billing_groups.fleet_id
      and fm.role_in_fleet in ('fleet_admin', 'owner')
  )
);

drop policy if exists "billing_group_items_select_scope" on public.billing_group_items;
create policy "billing_group_items_select_scope"
on public.billing_group_items
for select
to authenticated
using (
  public.can_access_case(billing_group_items.case_id)
  or public.is_staff(auth.uid())
);

drop policy if exists "billing_group_items_manage_scope" on public.billing_group_items;
create policy "billing_group_items_manage_scope"
on public.billing_group_items
for all
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.billing_groups bg
    join public.fleet_memberships fm on fm.fleet_id = bg.fleet_id
    where bg.id = billing_group_items.billing_group_id
      and fm.user_id = auth.uid()
      and fm.role_in_fleet in ('fleet_admin', 'owner')
  )
)
with check (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.billing_groups bg
    join public.fleet_memberships fm on fm.fleet_id = bg.fleet_id
    where bg.id = billing_group_items.billing_group_id
      and fm.user_id = auth.uid()
      and fm.role_in_fleet in ('fleet_admin', 'owner')
  )
);
