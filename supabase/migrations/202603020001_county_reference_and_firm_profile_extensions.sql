-- County reference library + attorney firm profile extensions.
-- Safe to run multiple times.

create table if not exists public.county_reference (
  id uuid primary key default gen_random_uuid(),
  state_code text not null,
  county_name text not null,
  county_display text,
  county_slug text,
  county_uid text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (state_code, county_name)
);

create index if not exists idx_county_reference_state on public.county_reference (state_code, county_name);
create index if not exists idx_county_reference_uid on public.county_reference (county_uid);

drop trigger if exists trg_county_reference_updated_at on public.county_reference;
create trigger trg_county_reference_updated_at
before update on public.county_reference
for each row
execute function public.set_updated_at();

alter table public.county_reference enable row level security;

drop policy if exists "county_reference_select_all_authenticated" on public.county_reference;
drop policy if exists "county_reference_manage_staff_only" on public.county_reference;

create policy "county_reference_select_all_authenticated"
on public.county_reference
for select
to authenticated
using (true);

create policy "county_reference_manage_staff_only"
on public.county_reference
for all
to authenticated
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

alter table public.attorney_onboarding_profiles add column if not exists coverage_states jsonb;
alter table public.attorney_onboarding_profiles add column if not exists primary_county text;

alter table public.attorney_firms add column if not exists coverage_states jsonb;
alter table public.attorney_firms add column if not exists primary_county text;
alter table public.attorney_firms add column if not exists office_address text;
alter table public.attorney_firms add column if not exists city text;
alter table public.attorney_firms add column if not exists zip_code text;

