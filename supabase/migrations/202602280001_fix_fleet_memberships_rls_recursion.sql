-- Hotfix: prevent RLS recursion between fleets and fleet_memberships.
-- Safe to run multiple times.

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

revoke all on function public.can_access_fleet(uuid) from public;
revoke all on function public.can_manage_fleet(uuid) from public;
grant execute on function public.can_access_fleet(uuid) to authenticated;
grant execute on function public.can_manage_fleet(uuid) to authenticated;

alter table if exists public.fleets enable row level security;
alter table if exists public.fleet_memberships enable row level security;

drop policy if exists "fleets_select_scope" on public.fleets;
drop policy if exists "fleets_manage_scope" on public.fleets;
drop policy if exists "fleet_memberships_select_scope" on public.fleet_memberships;
drop policy if exists "fleet_memberships_manage_scope" on public.fleet_memberships;

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
