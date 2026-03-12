-- Phase 1: DB-enforced, role-aware case status transitions.
-- Safe to run multiple times.

create table if not exists public.case_status_transition_rules (
  actor_scope text not null,
  from_status text not null,
  to_status text not null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (actor_scope, from_status, to_status)
);

alter table public.case_status_transition_rules
  drop constraint if exists case_status_transition_rules_actor_scope_check;
alter table public.case_status_transition_rules
  add constraint case_status_transition_rules_actor_scope_check
  check (actor_scope in ('STAFF', 'AGENCY_FLEET', 'ATTORNEY', 'DRIVER'));

alter table public.case_status_transition_rules
  drop constraint if exists case_status_transition_rules_from_status_check;
alter table public.case_status_transition_rules
  add constraint case_status_transition_rules_from_status_check
  check (
    from_status in (
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

alter table public.case_status_transition_rules
  drop constraint if exists case_status_transition_rules_to_status_check;
alter table public.case_status_transition_rules
  add constraint case_status_transition_rules_to_status_check
  check (
    to_status in (
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

delete from public.case_status_transition_rules
where actor_scope in ('STAFF', 'AGENCY_FLEET', 'ATTORNEY', 'DRIVER');

insert into public.case_status_transition_rules (actor_scope, from_status, to_status, is_enabled)
values
  -- STAFF
  ('STAFF', 'INTAKE_RECEIVED', 'NEEDS_REVIEW', true),
  ('STAFF', 'NEEDS_REVIEW', 'ATTORNEY_MATCHING', true),
  ('STAFF', 'ATTORNEY_MATCHING', 'OFFERED_TO_ATTORNEY', true),
  ('STAFF', 'OFFERED_TO_ATTORNEY', 'ATTORNEY_ACCEPTED', true),
  ('STAFF', 'OFFERED_TO_ATTORNEY', 'ATTORNEY_MATCHING', true),
  ('STAFF', 'ATTORNEY_ACCEPTED', 'CLIENT_DOCS_REQUIRED', true),
  ('STAFF', 'ATTORNEY_ACCEPTED', 'IN_PROGRESS', true),
  ('STAFF', 'CLIENT_DOCS_REQUIRED', 'IN_PROGRESS', true),
  ('STAFF', 'IN_PROGRESS', 'COURT_PENDING', true),
  ('STAFF', 'COURT_PENDING', 'AWAITING_DISPOSITION', true),
  ('STAFF', 'AWAITING_DISPOSITION', 'DISPOSITION_RECEIVED', true),
  ('STAFF', 'DISPOSITION_RECEIVED', 'CLOSED', true),
  ('STAFF', 'INTAKE_RECEIVED', 'CANCELLED', true),
  ('STAFF', 'NEEDS_REVIEW', 'CANCELLED', true),
  ('STAFF', 'ATTORNEY_MATCHING', 'CANCELLED', true),
  ('STAFF', 'OFFERED_TO_ATTORNEY', 'CANCELLED', true),
  ('STAFF', 'ATTORNEY_ACCEPTED', 'CANCELLED', true),
  ('STAFF', 'CLIENT_DOCS_REQUIRED', 'CANCELLED', true),
  ('STAFF', 'IN_PROGRESS', 'CANCELLED', true),
  ('STAFF', 'COURT_PENDING', 'CANCELLED', true),
  ('STAFF', 'AWAITING_DISPOSITION', 'CANCELLED', true),
  ('STAFF', 'DISPOSITION_RECEIVED', 'CANCELLED', true),
  ('STAFF', 'INTAKE_RECEIVED', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'NEEDS_REVIEW', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'ATTORNEY_MATCHING', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'OFFERED_TO_ATTORNEY', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'ATTORNEY_ACCEPTED', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'CLIENT_DOCS_REQUIRED', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'IN_PROGRESS', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'COURT_PENDING', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'AWAITING_DISPOSITION', 'UNABLE_TO_SERVICE', true),
  ('STAFF', 'DISPOSITION_RECEIVED', 'UNABLE_TO_SERVICE', true),

  -- AGENCY_FLEET
  ('AGENCY_FLEET', 'INTAKE_RECEIVED', 'NEEDS_REVIEW', true),
  ('AGENCY_FLEET', 'NEEDS_REVIEW', 'ATTORNEY_MATCHING', true),
  ('AGENCY_FLEET', 'ATTORNEY_MATCHING', 'OFFERED_TO_ATTORNEY', true),
  ('AGENCY_FLEET', 'OFFERED_TO_ATTORNEY', 'ATTORNEY_MATCHING', true),
  ('AGENCY_FLEET', 'ATTORNEY_ACCEPTED', 'CLIENT_DOCS_REQUIRED', true),
  ('AGENCY_FLEET', 'ATTORNEY_ACCEPTED', 'IN_PROGRESS', true),
  ('AGENCY_FLEET', 'CLIENT_DOCS_REQUIRED', 'IN_PROGRESS', true),
  ('AGENCY_FLEET', 'IN_PROGRESS', 'COURT_PENDING', true),
  ('AGENCY_FLEET', 'COURT_PENDING', 'AWAITING_DISPOSITION', true),
  ('AGENCY_FLEET', 'AWAITING_DISPOSITION', 'DISPOSITION_RECEIVED', true),
  ('AGENCY_FLEET', 'DISPOSITION_RECEIVED', 'CLOSED', true),
  ('AGENCY_FLEET', 'INTAKE_RECEIVED', 'CANCELLED', true),
  ('AGENCY_FLEET', 'NEEDS_REVIEW', 'CANCELLED', true),
  ('AGENCY_FLEET', 'ATTORNEY_MATCHING', 'CANCELLED', true),
  ('AGENCY_FLEET', 'OFFERED_TO_ATTORNEY', 'CANCELLED', true),
  ('AGENCY_FLEET', 'ATTORNEY_ACCEPTED', 'CANCELLED', true),
  ('AGENCY_FLEET', 'CLIENT_DOCS_REQUIRED', 'CANCELLED', true),
  ('AGENCY_FLEET', 'IN_PROGRESS', 'CANCELLED', true),
  ('AGENCY_FLEET', 'COURT_PENDING', 'CANCELLED', true),
  ('AGENCY_FLEET', 'AWAITING_DISPOSITION', 'CANCELLED', true),
  ('AGENCY_FLEET', 'DISPOSITION_RECEIVED', 'CANCELLED', true),
  ('AGENCY_FLEET', 'INTAKE_RECEIVED', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'NEEDS_REVIEW', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'ATTORNEY_MATCHING', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'OFFERED_TO_ATTORNEY', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'ATTORNEY_ACCEPTED', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'CLIENT_DOCS_REQUIRED', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'IN_PROGRESS', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'COURT_PENDING', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'AWAITING_DISPOSITION', 'UNABLE_TO_SERVICE', true),
  ('AGENCY_FLEET', 'DISPOSITION_RECEIVED', 'UNABLE_TO_SERVICE', true),

  -- ATTORNEY
  ('ATTORNEY', 'OFFERED_TO_ATTORNEY', 'ATTORNEY_ACCEPTED', true),
  ('ATTORNEY', 'OFFERED_TO_ATTORNEY', 'ATTORNEY_MATCHING', true),
  ('ATTORNEY', 'ATTORNEY_ACCEPTED', 'CLIENT_DOCS_REQUIRED', true),
  ('ATTORNEY', 'ATTORNEY_ACCEPTED', 'IN_PROGRESS', true),
  ('ATTORNEY', 'CLIENT_DOCS_REQUIRED', 'IN_PROGRESS', true),
  ('ATTORNEY', 'IN_PROGRESS', 'COURT_PENDING', true),
  ('ATTORNEY', 'COURT_PENDING', 'AWAITING_DISPOSITION', true),
  ('ATTORNEY', 'AWAITING_DISPOSITION', 'DISPOSITION_RECEIVED', true),
  ('ATTORNEY', 'DISPOSITION_RECEIVED', 'CLOSED', true)
on conflict (actor_scope, from_status, to_status)
do update set is_enabled = excluded.is_enabled;

create or replace function public.get_case_transition_actor_scope(target_case_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  profile_role text := 'NONE';
begin
  if target_case_id is null then
    return 'NONE';
  end if;

  uid := auth.uid();
  if uid is null then
    if coalesce(auth.role(), '') = 'service_role' or current_user in ('postgres', 'supabase_admin', 'service_role') then
      return 'STAFF';
    end if;
    return 'NONE';
  end if;

  if not public.can_access_case(target_case_id) then
    return 'NONE';
  end if;

  select upper(coalesce(p.system_role::text, 'NONE'))
  into profile_role
  from public.profiles p
  where p.id = uid or p.user_id = uid
  order by case when p.id = uid then 0 else 1 end
  limit 1;

  if profile_role in ('ADMIN', 'OPS', 'AGENT') then
    return 'STAFF';
  end if;

  if profile_role = 'ATTORNEY' then
    return 'ATTORNEY';
  end if;

  if profile_role in ('AGENCY', 'FLEET') then
    return 'AGENCY_FLEET';
  end if;

  if profile_role = 'DRIVER' then
    return 'DRIVER';
  end if;

  if exists (
    select 1
    from public.cases c
    where c.id = target_case_id
      and c.assigned_attorney_user_id = uid
  ) then
    return 'ATTORNEY';
  end if;

  if exists (
    select 1
    from public.cases c
    where c.id = target_case_id
      and (c.owner_id = uid or c.driver_id = uid)
  ) then
    return 'DRIVER';
  end if;

  if exists (
    select 1
    from public.cases c
    join public.attorney_firm_memberships afm
      on afm.firm_id = c.attorney_firm_id
    where c.id = target_case_id
      and afm.user_id = uid
  ) then
    return 'ATTORNEY';
  end if;

  if exists (
    select 1
    from public.cases c
    where c.id = target_case_id
      and (
        exists (
          select 1 from public.agency_memberships am
          where am.user_id = uid
            and am.agency_id = c.agency_id
        )
        or exists (
          select 1 from public.fleet_memberships fm
          where fm.user_id = uid
            and fm.fleet_id = c.fleet_id
        )
      )
  ) then
    return 'AGENCY_FLEET';
  end if;

  return 'NONE';
end;
$$;

create or replace function public.is_case_status_transition_allowed(
  actor_scope text,
  from_status text,
  to_status text
)
returns boolean
language sql
stable
set search_path = public
as $$
  with normalized as (
    select
      upper(trim(coalesce(actor_scope, ''))) as actor_scope,
      upper(trim(coalesce(from_status, ''))) as from_status,
      upper(trim(coalesce(to_status, ''))) as to_status
  )
  select case
    when n.from_status = n.to_status then true
    else exists (
      select 1
      from public.case_status_transition_rules r
      where r.actor_scope = n.actor_scope
        and r.from_status = n.from_status
        and r.to_status = n.to_status
        and r.is_enabled
    )
  end
  from normalized n;
$$;

create or replace function public.assert_case_status_transition_for_actor(
  actor_scope text,
  from_status text,
  to_status text
)
returns void
language plpgsql
stable
set search_path = public
as $$
begin
  if not public.is_case_status_transition_allowed(actor_scope, from_status, to_status) then
    raise exception 'CASE_STATUS_TRANSITION_BLOCKED: role % cannot move case from % to %',
      upper(trim(coalesce(actor_scope, ''))),
      upper(trim(coalesce(from_status, ''))),
      upper(trim(coalesce(to_status, '')))
      using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.assert_case_status_transition(
  target_case_id uuid,
  from_status text,
  to_status text
)
returns void
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  actor_scope text;
begin
  actor_scope := public.get_case_transition_actor_scope(target_case_id);

  if actor_scope = 'NONE' then
    raise exception 'CASE_STATUS_ACCESS_DENIED: cannot transition case %', target_case_id
      using errcode = '42501';
  end if;

  perform public.assert_case_status_transition_for_actor(actor_scope, from_status, to_status);
end;
$$;

create or replace function public.transition_case_status(
  p_case_id uuid,
  p_to_status text,
  p_reason text default null,
  p_metadata jsonb default null
)
returns table(previous_status text, new_status text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_status text;
  target_status text;
begin
  if p_case_id is null then
    raise exception 'Case id is required.' using errcode = '22023';
  end if;

  target_status := upper(trim(coalesce(p_to_status, '')));
  if target_status = '' then
    raise exception 'Target status is required.' using errcode = '22023';
  end if;

  select c.status::text
  into current_status
  from public.cases c
  where c.id = p_case_id
  for update;

  if current_status is null then
    raise exception 'Case not found or access denied.' using errcode = '42501';
  end if;

  perform public.assert_case_status_transition(p_case_id, current_status, target_status);

  if current_status <> target_status then
    update public.cases
    set status = target_status,
        updated_at = now()
    where id = p_case_id;
  end if;

  previous_status := current_status;
  new_status := target_status;
  return next;
end;
$$;

create or replace function public.enforce_case_status_transition_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if old.status is distinct from new.status then
    perform public.assert_case_status_transition(old.id, old.status::text, new.status::text);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cases_status_transition_guard on public.cases;
create trigger trg_cases_status_transition_guard
before update of status on public.cases
for each row
execute function public.enforce_case_status_transition_trigger();

revoke all on function public.get_case_transition_actor_scope(uuid) from public;
revoke all on function public.is_case_status_transition_allowed(text, text, text) from public;
revoke all on function public.assert_case_status_transition_for_actor(text, text, text) from public;
revoke all on function public.assert_case_status_transition(uuid, text, text) from public;
revoke all on function public.transition_case_status(uuid, text, text, jsonb) from public;
grant execute on function public.get_case_transition_actor_scope(uuid) to authenticated, service_role;
grant execute on function public.is_case_status_transition_allowed(text, text, text) to authenticated, service_role;
grant execute on function public.assert_case_status_transition_for_actor(text, text, text) to authenticated, service_role;
grant execute on function public.assert_case_status_transition(uuid, text, text) to authenticated, service_role;
grant execute on function public.transition_case_status(uuid, text, text, jsonb) to authenticated, service_role;

