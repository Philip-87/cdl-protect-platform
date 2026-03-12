-- Role-based case processing foundation for CDL Protect.
-- Safe to run multiple times.

create extension if not exists pgcrypto;

-- Normalize role semantics for multi-tenant access.
do $$
declare
  role_udt text;
  c record;
begin
  if to_regclass('public.profiles') is null then
    return;
  end if;

  select cols.udt_name
  into role_udt
  from information_schema.columns cols
  where cols.table_schema = 'public'
    and cols.table_name = 'profiles'
    and cols.column_name = 'system_role';

  if role_udt is null then
    return;
  end if;

  begin
    execute 'alter table public.profiles alter column system_role drop default';
  exception when others then null;
  end;

  if role_udt <> 'text' then
    begin
      execute 'alter table public.profiles alter column system_role type text using system_role::text';
    exception when others then null;
    end;
  end if;

  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%system_role%'
  loop
    execute format('alter table public.profiles drop constraint if exists %I', c.conname);
  end loop;

  update public.profiles
  set system_role = case
    when upper(coalesce(system_role::text, '')) in ('ADMIN') then 'ADMIN'
    when upper(coalesce(system_role::text, '')) in ('OPS', 'OPERATIONS', 'SUPPORT') then 'OPS'
    when upper(coalesce(system_role::text, '')) in ('AGENT') then 'AGENT'
    when upper(coalesce(system_role::text, '')) in ('AGENCY', 'AGENCY_ADMIN') then 'AGENCY'
    when upper(coalesce(system_role::text, '')) in ('FLEET', 'FLEET_ADMIN') then 'FLEET'
    when upper(coalesce(system_role::text, '')) in ('ATTORNEY', 'LAW_FIRM') then 'ATTORNEY'
    when upper(coalesce(system_role::text, '')) in ('DRIVER') then 'DRIVER'
    else 'NONE'
  end;

  update public.profiles
  set system_role = 'NONE'
  where system_role is null or btrim(system_role) = '';

  begin
    execute 'alter table public.profiles alter column system_role set not null';
  exception when others then null;
  end;

  execute $sql$
    alter table public.profiles
    add constraint profiles_system_role_check
    check (system_role in ('NONE', 'DRIVER', 'FLEET', 'AGENCY', 'ATTORNEY', 'ADMIN', 'OPS', 'AGENT'))
  $sql$;

  execute 'alter table public.profiles alter column system_role set default ''NONE''';
end $$;

-- Tenant entities.
create table if not exists public.agencies (
  id uuid primary key default gen_random_uuid(),
  contact_name text,
  company_name text not null,
  address text,
  phone text,
  email text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fleets (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references public.agencies (id) on delete cascade,
  contact_name text,
  company_name text not null,
  address text,
  phone text,
  email text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attorney_firms (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  contact_name text,
  email text,
  phone text,
  state text,
  counties jsonb,
  coverage_notes text,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agency_memberships (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role_in_agency text not null default 'agency_admin',
  created_at timestamptz not null default now(),
  unique (agency_id, user_id)
);

create table if not exists public.fleet_memberships (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role_in_fleet text not null default 'fleet_admin',
  created_at timestamptz not null default now(),
  unique (fleet_id, user_id)
);

create table if not exists public.attorney_firm_memberships (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.attorney_firms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role_in_firm text not null default 'attorney_admin',
  created_at timestamptz not null default now(),
  unique (firm_id, user_id)
);

create table if not exists public.platform_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  target_role text not null,
  agency_id uuid references public.agencies (id) on delete set null,
  fleet_id uuid references public.fleets (id) on delete set null,
  firm_id uuid references public.attorney_firms (id) on delete set null,
  invited_by uuid references auth.users (id) on delete set null,
  invite_token text not null default encode(gen_random_bytes(24), 'hex'),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_platform_invites_active_email
  on public.platform_invites (lower(email), target_role)
  where accepted_at is null;

-- Case model extension.
alter table public.cases add column if not exists agency_id uuid references public.agencies (id) on delete set null;
alter table public.cases add column if not exists fleet_id uuid references public.fleets (id) on delete set null;
alter table public.cases add column if not exists attorney_firm_id uuid references public.attorney_firms (id) on delete set null;
alter table public.cases add column if not exists assigned_attorney_user_id uuid references auth.users (id) on delete set null;
alter table public.cases add column if not exists driver_id uuid references auth.users (id) on delete set null;
alter table public.cases add column if not exists court_name text;
alter table public.cases add column if not exists court_address text;
alter table public.cases add column if not exists court_time text;

create table if not exists public.case_assignments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  firm_id uuid not null references public.attorney_firms (id) on delete cascade,
  offered_by uuid references auth.users (id) on delete set null,
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason text
);

-- Normalize legacy case_assignments schemas where table already existed.
alter table public.case_assignments add column if not exists case_id uuid;
alter table public.case_assignments add column if not exists firm_id uuid;
alter table public.case_assignments add column if not exists offered_by uuid references auth.users (id) on delete set null;
alter table public.case_assignments add column if not exists offered_at timestamptz not null default now();
alter table public.case_assignments add column if not exists expires_at timestamptz not null default (now() + interval '24 hours');
alter table public.case_assignments add column if not exists accepted_at timestamptz;
alter table public.case_assignments add column if not exists declined_at timestamptz;
alter table public.case_assignments add column if not exists decline_reason text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'case_assignments' and column_name = 'attorney_firm_id'
  ) then
    execute 'update public.case_assignments set firm_id = attorney_firm_id where firm_id is null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'case_assignments' and column_name = 'attorney_id'
  ) then
    execute 'update public.case_assignments set firm_id = attorney_id where firm_id is null';
  end if;
end $$;

do $$
begin
  begin
    execute 'alter table public.case_assignments add constraint case_assignments_case_id_fkey foreign key (case_id) references public.cases(id) on delete cascade';
  exception when others then null;
  end;

  begin
    execute 'alter table public.case_assignments add constraint case_assignments_firm_id_fkey foreign key (firm_id) references public.attorney_firms(id) on delete cascade';
  exception when others then null;
  end;
end $$;

create table if not exists public.case_tasks (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  task_type text not null,
  requested_by_user_id uuid references auth.users (id) on delete set null,
  target_role text,
  target_user_id uuid references auth.users (id) on delete set null,
  instructions text,
  status text not null default 'OPEN',
  due_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.case_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  sender_user_id uuid references auth.users (id) on delete set null,
  recipient_role text,
  body text not null,
  created_at timestamptz not null default now()
);

-- Lifecycle status standardization.
do $$
declare
  status_udt text;
  c record;
begin
  select cols.udt_name
  into status_udt
  from information_schema.columns cols
  where cols.table_schema = 'public'
    and cols.table_name = 'cases'
    and cols.column_name = 'status';

  if status_udt is null then
    return;
  end if;

  if status_udt = 'case_status' then
    begin execute 'alter type case_status add value if not exists ''INTAKE_RECEIVED'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''NEEDS_REVIEW'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''ATTORNEY_MATCHING'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''OFFERED_TO_ATTORNEY'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''ATTORNEY_ACCEPTED'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''CLIENT_DOCS_REQUIRED'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''IN_PROGRESS'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''COURT_PENDING'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''AWAITING_DISPOSITION'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''DISPOSITION_RECEIVED'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''CLOSED'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''CANCELLED'''; exception when others then null; end;
    begin execute 'alter type case_status add value if not exists ''UNABLE_TO_SERVICE'''; exception when others then null; end;
  end if;

  begin
    execute 'alter table public.cases alter column status drop default';
  exception when others then null;
  end;

  if status_udt <> 'text' then
    begin
      execute 'alter table public.cases alter column status type text using status::text';
    exception when others then null;
    end;
  end if;

  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.cases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.cases drop constraint if exists %I', c.conname);
  end loop;

  update public.cases
  set status = case
    when upper(status::text) in ('INTAKE', 'NEW', 'OPEN', 'PENDING') then 'INTAKE_RECEIVED'
    when upper(status::text) in ('REVIEW', 'NEEDS_REVIEW') then 'NEEDS_REVIEW'
    when upper(status::text) in ('FILED') then 'IN_PROGRESS'
    when upper(status::text) in ('RESOLVED', 'CLOSED') then 'CLOSED'
    when upper(status::text) in (
      'INTAKE_RECEIVED',
      'NEEDS_REVIEW',
      'ATTORNEY_MATCHING',
      'OFFERED_TO_ATTORNEY',
      'ATTORNEY_ACCEPTED',
      'CLIENT_DOCS_REQUIRED',
      'IN_PROGRESS',
      'COURT_PENDING',
      'AWAITING_DISPOSITION',
      'DISPOSITION_RECEIVED',
      'CLOSED',
      'CANCELLED',
      'UNABLE_TO_SERVICE'
    ) then upper(status::text)
    else 'INTAKE_RECEIVED'
  end;
exception
  when others then null;
end $$;

alter table public.cases alter column status set default 'INTAKE_RECEIVED';
alter table public.cases drop constraint if exists cases_status_check;
alter table public.cases add constraint cases_status_check
check (
  status::text in (
    'INTAKE_RECEIVED',
    'NEEDS_REVIEW',
    'ATTORNEY_MATCHING',
    'OFFERED_TO_ATTORNEY',
    'ATTORNEY_ACCEPTED',
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

-- Updated-at triggers for new mutable tables.
drop trigger if exists trg_agencies_updated_at on public.agencies;
create trigger trg_agencies_updated_at
before update on public.agencies
for each row
execute function public.set_updated_at();

drop trigger if exists trg_fleets_updated_at on public.fleets;
create trigger trg_fleets_updated_at
before update on public.fleets
for each row
execute function public.set_updated_at();

drop trigger if exists trg_attorney_firms_updated_at on public.attorney_firms;
create trigger trg_attorney_firms_updated_at
before update on public.attorney_firms
for each row
execute function public.set_updated_at();

drop trigger if exists trg_case_tasks_updated_at on public.case_tasks;
create trigger trg_case_tasks_updated_at
before update on public.case_tasks
for each row
execute function public.set_updated_at();

-- Access helpers.
create or replace function public.is_staff(user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  v_user_id uuid := user_id;
  result_value boolean;
begin
  select exists (
    select 1
    from public.profiles p
    where (p.id = v_user_id or p.user_id = v_user_id)
      and upper(coalesce(p.system_role::text, 'NONE')) in ('AGENT', 'ADMIN', 'OPS')
  )
  into result_value;

  return coalesce(result_value, false);
end;
$$;

create or replace function public.can_access_case(target_case_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
begin
  uid := auth.uid();
  if uid is null then
    return false;
  end if;

  if public.is_staff(uid) then
    return exists (select 1 from public.cases c where c.id = target_case_id);
  end if;

  return exists (
    select 1
    from public.cases c
    where c.id = target_case_id
      and (
        c.owner_id = uid
        or c.driver_id = uid
        or c.assigned_attorney_user_id = uid
        or exists (
          select 1
          from public.fleet_memberships fm
          where fm.user_id = uid
            and fm.fleet_id = c.fleet_id
        )
        or exists (
          select 1
          from public.agency_memberships am
          where am.user_id = uid
            and am.agency_id = c.agency_id
        )
        or exists (
          select 1
          from public.attorney_firm_memberships afm
          where afm.user_id = uid
            and afm.firm_id = c.attorney_firm_id
        )
        or exists (
          select 1
          from public.case_assignments ca
          join public.attorney_firm_memberships afm
            on afm.firm_id = ca.firm_id
           and afm.user_id = uid
          where ca.case_id = c.id
            and ca.accepted_at is not null
        )
      )
  );
end;
$$;

create or replace function public.can_access_case(case_id_text text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  parsed uuid;
begin
  begin
    parsed := case_id_text::uuid;
  exception when others then
    return false;
  end;

  return public.can_access_case(parsed);
end;
$$;

create or replace function public.can_access_fleet(target_fleet_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
begin
  uid := auth.uid();
  if uid is null then
    return false;
  end if;

  if public.is_staff(uid) then
    return exists (select 1 from public.fleets f where f.id = target_fleet_id);
  end if;

  return exists (
    select 1
    from public.fleets f
    where f.id = target_fleet_id
      and (
        exists (
          select 1
          from public.fleet_memberships fm
          where fm.fleet_id = f.id
            and fm.user_id = uid
        )
        or exists (
          select 1
          from public.agency_memberships am
          where am.agency_id = f.agency_id
            and am.user_id = uid
        )
      )
  );
end;
$$;

create or replace function public.can_manage_fleet(target_fleet_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
begin
  uid := auth.uid();
  if uid is null then
    return false;
  end if;

  if public.is_staff(uid) then
    return exists (select 1 from public.fleets f where f.id = target_fleet_id);
  end if;

  return exists (
    select 1
    from public.fleets f
    where f.id = target_fleet_id
      and (
        exists (
          select 1
          from public.agency_memberships am
          where am.agency_id = f.agency_id
            and am.user_id = uid
            and am.role_in_agency in ('agency_admin', 'owner')
        )
        or exists (
          select 1
          from public.fleet_memberships fm
          where fm.fleet_id = f.id
            and fm.user_id = uid
            and fm.role_in_fleet in ('fleet_admin', 'owner')
        )
      )
  );
end;
$$;

revoke all on function public.is_staff(uuid) from public;
revoke all on function public.can_access_case(uuid) from public;
revoke all on function public.can_access_case(text) from public;
revoke all on function public.can_access_fleet(uuid) from public;
revoke all on function public.can_manage_fleet(uuid) from public;
grant execute on function public.is_staff(uuid) to authenticated;
grant execute on function public.can_access_case(uuid) to authenticated;
grant execute on function public.can_access_case(text) to authenticated;
grant execute on function public.can_access_fleet(uuid) to authenticated;
grant execute on function public.can_manage_fleet(uuid) to authenticated;

-- Helpful indexes.
create index if not exists idx_cases_agency_id on public.cases (agency_id);
create index if not exists idx_cases_fleet_id on public.cases (fleet_id);
create index if not exists idx_cases_attorney_firm_id on public.cases (attorney_firm_id);
create index if not exists idx_cases_assigned_attorney on public.cases (assigned_attorney_user_id);
create index if not exists idx_case_assignments_case_id on public.case_assignments (case_id, offered_at desc);
create index if not exists idx_case_tasks_case_id on public.case_tasks (case_id, created_at desc);
create index if not exists idx_case_tasks_status_due on public.case_tasks (status, due_at);
create index if not exists idx_agency_memberships_user on public.agency_memberships (user_id, agency_id);
create index if not exists idx_fleet_memberships_user on public.fleet_memberships (user_id, fleet_id);
create index if not exists idx_attorney_firm_memberships_user on public.attorney_firm_memberships (user_id, firm_id);

-- Reset and apply RLS policies with role-aware helper checks.
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'cases',
        'documents',
        'case_events',
        'agencies',
        'fleets',
        'attorney_firms',
        'agency_memberships',
        'fleet_memberships',
        'attorney_firm_memberships',
        'platform_invites',
        'case_assignments',
        'case_tasks',
        'case_messages'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

alter table public.agencies enable row level security;
alter table public.fleets enable row level security;
alter table public.attorney_firms enable row level security;
alter table public.agency_memberships enable row level security;
alter table public.fleet_memberships enable row level security;
alter table public.attorney_firm_memberships enable row level security;
alter table public.platform_invites enable row level security;
alter table public.case_assignments enable row level security;
alter table public.case_tasks enable row level security;
alter table public.case_messages enable row level security;
alter table public.cases enable row level security;
alter table public.documents enable row level security;
alter table public.case_events enable row level security;

create policy "cases_select_role_scope"
on public.cases
for select
to authenticated
using (public.can_access_case(cases.id));

create policy "cases_insert_role_scope"
on public.cases
for insert
to authenticated
with check (
  public.is_staff(auth.uid())
  or owner_id = auth.uid()
  or driver_id = auth.uid()
  or exists (
    select 1
    from public.agency_memberships am
    where am.user_id = auth.uid()
      and am.agency_id = cases.agency_id
  )
  or exists (
    select 1
    from public.fleet_memberships fm
    where fm.user_id = auth.uid()
      and fm.fleet_id = cases.fleet_id
  )
);

create policy "cases_update_role_scope"
on public.cases
for update
to authenticated
using (public.can_access_case(cases.id))
with check (
  public.can_access_case(cases.id)
  and (
    public.is_staff(auth.uid())
    or owner_id = auth.uid()
    or exists (
      select 1
      from public.agency_memberships am
      where am.user_id = auth.uid()
        and am.agency_id = cases.agency_id
    )
    or exists (
      select 1
      from public.fleet_memberships fm
      where fm.user_id = auth.uid()
        and fm.fleet_id = cases.fleet_id
    )
    or exists (
      select 1
      from public.attorney_firm_memberships afm
      where afm.user_id = auth.uid()
        and afm.firm_id = cases.attorney_firm_id
    )
    or assigned_attorney_user_id = auth.uid()
  )
);

create policy "cases_delete_role_scope"
on public.cases
for delete
to authenticated
using (
  public.is_staff(auth.uid())
  or owner_id = auth.uid()
  or exists (
    select 1
    from public.agency_memberships am
    where am.user_id = auth.uid()
      and am.agency_id = cases.agency_id
  )
  or exists (
    select 1
    from public.fleet_memberships fm
    where fm.user_id = auth.uid()
      and fm.fleet_id = cases.fleet_id
  )
);

create policy "documents_role_scope_select"
on public.documents
for select
to authenticated
using (public.can_access_case(documents.case_id));

create policy "documents_role_scope_insert"
on public.documents
for insert
to authenticated
with check (
  (uploaded_by is null or uploaded_by = auth.uid())
  and public.can_access_case(documents.case_id)
);

create policy "documents_role_scope_update"
on public.documents
for update
to authenticated
using (public.can_access_case(documents.case_id))
with check (public.can_access_case(documents.case_id));

create policy "documents_role_scope_delete"
on public.documents
for delete
to authenticated
using (public.can_access_case(documents.case_id));

create policy "case_events_role_scope_select"
on public.case_events
for select
to authenticated
using (public.can_access_case(case_events.case_id));

create policy "case_events_role_scope_insert"
on public.case_events
for insert
to authenticated
with check (
  (actor_id is null or actor_id = auth.uid())
  and public.can_access_case(case_events.case_id)
);

create policy "agencies_select_members_or_staff"
on public.agencies
for select
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.agency_memberships am
    where am.agency_id = agencies.id
      and am.user_id = auth.uid()
  )
);

create policy "agencies_manage_members_or_staff"
on public.agencies
for all
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.agency_memberships am
    where am.agency_id = agencies.id
      and am.user_id = auth.uid()
      and am.role_in_agency in ('agency_admin', 'owner')
  )
)
with check (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.agency_memberships am
    where am.agency_id = agencies.id
      and am.user_id = auth.uid()
      and am.role_in_agency in ('agency_admin', 'owner')
  )
);

create policy "fleets_select_scope"
on public.fleets
for select
to authenticated
using (public.can_access_fleet(fleets.id));

create policy "fleets_manage_scope"
on public.fleets
for all
to authenticated
using (public.can_manage_fleet(fleets.id))
with check (public.can_manage_fleet(fleets.id));

create policy "attorney_firms_select_scope"
on public.attorney_firms
for select
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.firm_id = attorney_firms.id
      and afm.user_id = auth.uid()
  )
);

create policy "attorney_firms_manage_scope"
on public.attorney_firms
for all
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.firm_id = attorney_firms.id
      and afm.user_id = auth.uid()
      and afm.role_in_firm in ('attorney_admin', 'owner')
  )
)
with check (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.firm_id = attorney_firms.id
      and afm.user_id = auth.uid()
      and afm.role_in_firm in ('attorney_admin', 'owner')
  )
);

create policy "agency_memberships_select_scope"
on public.agency_memberships
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

create policy "agency_memberships_manage_scope"
on public.agency_memberships
for all
to authenticated
using (
  public.is_staff(auth.uid())
)
with check (
  public.is_staff(auth.uid())
);

create policy "fleet_memberships_select_scope"
on public.fleet_memberships
for select
to authenticated
using (
  fleet_memberships.user_id = auth.uid()
  or public.can_access_fleet(fleet_memberships.fleet_id)
);

create policy "fleet_memberships_manage_scope"
on public.fleet_memberships
for all
to authenticated
using (public.can_manage_fleet(fleet_memberships.fleet_id))
with check (public.can_manage_fleet(fleet_memberships.fleet_id));

create policy "attorney_firm_memberships_select_scope"
on public.attorney_firm_memberships
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

create policy "attorney_firm_memberships_manage_scope"
on public.attorney_firm_memberships
for all
to authenticated
using (
  public.is_staff(auth.uid())
)
with check (
  public.is_staff(auth.uid())
);

create policy "platform_invites_scope"
on public.platform_invites
for all
to authenticated
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

create policy "platform_invites_select_self"
on public.platform_invites
for select
to authenticated
using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

create policy "case_assignments_scope"
on public.case_assignments
for select
to authenticated
using (
  public.can_access_case(case_assignments.case_id)
  or exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.firm_id = case_assignments.firm_id
      and afm.user_id = auth.uid()
  )
);

create policy "case_assignments_manage_scope"
on public.case_assignments
for all
to authenticated
using (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.firm_id = case_assignments.firm_id
      and afm.user_id = auth.uid()
  )
)
with check (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.firm_id = case_assignments.firm_id
      and afm.user_id = auth.uid()
  )
);

create policy "case_tasks_scope_select"
on public.case_tasks
for select
to authenticated
using (public.can_access_case(case_tasks.case_id));

create policy "case_tasks_scope_manage"
on public.case_tasks
for all
to authenticated
using (public.can_access_case(case_tasks.case_id))
with check (public.can_access_case(case_tasks.case_id));

create policy "case_messages_scope_select"
on public.case_messages
for select
to authenticated
using (public.can_access_case(case_messages.case_id));

create policy "case_messages_scope_insert"
on public.case_messages
for insert
to authenticated
with check (
  sender_user_id = auth.uid()
  and public.can_access_case(case_messages.case_id)
);

-- Storage policies scoped to case access helper.
do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
  loop
    execute format('drop policy if exists %I on storage.objects', p.policyname);
  end loop;
end $$;

create policy "storage_case_docs_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'case-documents'
  and public.can_access_case(split_part(name, '/', 1))
);

create policy "storage_case_docs_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'case-documents'
  and public.can_access_case(split_part(name, '/', 1))
);

create policy "storage_case_docs_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'case-documents'
  and public.can_access_case(split_part(name, '/', 1))
);
