-- Attorney onboarding profile and coverage fee structures.
-- Safe to run multiple times.

create table if not exists public.attorney_onboarding_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  firm_id uuid references public.attorney_firms (id) on delete set null,
  full_name text not null,
  email text not null,
  phone text not null,
  state text not null,
  office_address text not null,
  city text,
  zip_code text not null,
  payment_methods text[] not null default '{}',
  payment_identifier text not null,
  other_payment text,
  fee_mode text not null default 'GLOBAL',
  cdl_flat_fee numeric,
  non_cdl_flat_fee numeric,
  counties jsonb,
  agreed_to_terms boolean not null default false,
  terms_version text,
  signature_text text,
  signed_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

do $$
begin
  begin
    execute 'alter table public.attorney_onboarding_profiles add constraint attorney_onboarding_profiles_fee_mode_check check (fee_mode in (''GLOBAL'', ''BY_COUNTY''))';
  exception when duplicate_object then null;
  end;
end $$;

create table if not exists public.attorney_county_fees (
  id uuid primary key default gen_random_uuid(),
  attorney_profile_id uuid not null references public.attorney_onboarding_profiles (id) on delete cascade,
  state text not null,
  county_name text not null,
  cdl_fee numeric not null,
  non_cdl_fee numeric not null,
  created_at timestamptz not null default now(),
  unique (attorney_profile_id, state, county_name)
);

create index if not exists idx_attorney_onboarding_user on public.attorney_onboarding_profiles (user_id);
create index if not exists idx_attorney_onboarding_firm on public.attorney_onboarding_profiles (firm_id);
create index if not exists idx_attorney_county_fees_profile on public.attorney_county_fees (attorney_profile_id);
create index if not exists idx_attorney_county_fees_state_county on public.attorney_county_fees (state, county_name);

drop trigger if exists trg_attorney_onboarding_profiles_updated_at on public.attorney_onboarding_profiles;
create trigger trg_attorney_onboarding_profiles_updated_at
before update on public.attorney_onboarding_profiles
for each row
execute function public.set_updated_at();

alter table public.attorney_onboarding_profiles enable row level security;
alter table public.attorney_county_fees enable row level security;

drop policy if exists "attorney_onboarding_select_scope" on public.attorney_onboarding_profiles;
drop policy if exists "attorney_onboarding_insert_scope" on public.attorney_onboarding_profiles;
drop policy if exists "attorney_onboarding_update_scope" on public.attorney_onboarding_profiles;
drop policy if exists "attorney_county_fees_select_scope" on public.attorney_county_fees;
drop policy if exists "attorney_county_fees_manage_scope" on public.attorney_county_fees;

create policy "attorney_onboarding_select_scope"
on public.attorney_onboarding_profiles
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

create policy "attorney_onboarding_insert_scope"
on public.attorney_onboarding_profiles
for insert
to authenticated
with check (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

create policy "attorney_onboarding_update_scope"
on public.attorney_onboarding_profiles
for update
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
)
with check (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

create policy "attorney_county_fees_select_scope"
on public.attorney_county_fees
for select
to authenticated
using (
  exists (
    select 1
    from public.attorney_onboarding_profiles p
    where p.id = attorney_county_fees.attorney_profile_id
      and (p.user_id = auth.uid() or public.is_staff(auth.uid()))
  )
);

create policy "attorney_county_fees_manage_scope"
on public.attorney_county_fees
for all
to authenticated
using (
  exists (
    select 1
    from public.attorney_onboarding_profiles p
    where p.id = attorney_county_fees.attorney_profile_id
      and (p.user_id = auth.uid() or public.is_staff(auth.uid()))
  )
)
with check (
  exists (
    select 1
    from public.attorney_onboarding_profiles p
    where p.id = attorney_county_fees.attorney_profile_id
      and (p.user_id = auth.uid() or public.is_staff(auth.uid()))
  )
);
