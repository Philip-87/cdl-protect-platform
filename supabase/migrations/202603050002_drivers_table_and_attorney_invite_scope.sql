-- Add explicit drivers table with RLS and allow attorney case-invite inserts via RLS.
-- Safe to run multiple times.

create extension if not exists pgcrypto;

create table if not exists public.drivers (
  id uuid primary key references auth.users (id) on delete cascade,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  email text,
  first_name text,
  last_name text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_drivers_user_id on public.drivers (user_id);
create index if not exists idx_drivers_email_lower on public.drivers (lower(email));

drop trigger if exists trg_drivers_updated_at on public.drivers;
create trigger trg_drivers_updated_at
before update on public.drivers
for each row
execute function public.set_updated_at();

create or replace function public.can_access_driver(target_driver_id uuid)
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
    return exists (select 1 from public.drivers d where d.id = target_driver_id);
  end if;

  return exists (
    select 1
    from public.drivers d
    where d.id = target_driver_id
      and (
        d.id = uid
        or d.user_id = uid
        or exists (
          select 1
          from public.cases c
          where c.driver_id = d.id
            and public.can_access_case(c.id)
        )
      )
  );
end;
$$;

revoke all on function public.can_access_driver(uuid) from public;
grant execute on function public.can_access_driver(uuid) to authenticated;

alter table public.drivers enable row level security;

drop policy if exists "drivers_select_scope" on public.drivers;
create policy "drivers_select_scope"
on public.drivers
for select
to authenticated
using (public.can_access_driver(drivers.id));

drop policy if exists "drivers_insert_scope" on public.drivers;
create policy "drivers_insert_scope"
on public.drivers
for insert
to authenticated
with check (
  public.is_staff(auth.uid())
  or (
    drivers.id = auth.uid()
    and drivers.user_id = auth.uid()
  )
);

drop policy if exists "drivers_update_scope" on public.drivers;
create policy "drivers_update_scope"
on public.drivers
for update
to authenticated
using (public.can_access_driver(drivers.id))
with check (
  public.is_staff(auth.uid())
  or (
    drivers.id = auth.uid()
    and drivers.user_id = auth.uid()
  )
);

drop policy if exists "drivers_delete_scope" on public.drivers;
create policy "drivers_delete_scope"
on public.drivers
for delete
to authenticated
using (public.is_staff(auth.uid()));

-- Attorneys can create scoped case participant invites without service-role fallback.
drop policy if exists "platform_invites_attorney_insert_scope" on public.platform_invites;
create policy "platform_invites_attorney_insert_scope"
on public.platform_invites
for insert
to authenticated
with check (
  upper(coalesce(platform_invites.target_role, '')) in ('DRIVER', 'AGENCY')
  and platform_invites.invited_by = auth.uid()
  and platform_invites.firm_id is not null
  and exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.user_id = auth.uid()
      and afm.firm_id = platform_invites.firm_id
  )
  and (
    platform_invites.agency_id is null
    or exists (
      select 1
      from public.cases c
      where c.attorney_firm_id = platform_invites.firm_id
        and c.agency_id = platform_invites.agency_id
        and public.can_access_case(c.id)
    )
  )
  and (
    platform_invites.fleet_id is null
    or exists (
      select 1
      from public.cases c
      where c.attorney_firm_id = platform_invites.firm_id
        and c.fleet_id = platform_invites.fleet_id
        and public.can_access_case(c.id)
    )
  )
);

