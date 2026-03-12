-- Repair insert-time RLS checks that depend on rows already existing.
-- Safe to run multiple times.

drop policy if exists "agencies_manage_members_or_staff" on public.agencies;
drop policy if exists "agencies_insert_creator_or_staff" on public.agencies;
drop policy if exists "agencies_update_members_or_staff" on public.agencies;
drop policy if exists "agencies_delete_members_or_staff" on public.agencies;

create policy "agencies_insert_creator_or_staff"
on public.agencies
for insert
to authenticated
with check (
  public.is_staff(auth.uid())
  or agencies.created_by = auth.uid()
);

create policy "agencies_update_members_or_staff"
on public.agencies
for update
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

create policy "agencies_delete_members_or_staff"
on public.agencies
for delete
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
);

drop policy if exists "fleets_manage_scope" on public.fleets;
drop policy if exists "fleets_insert_scope" on public.fleets;
drop policy if exists "fleets_update_scope" on public.fleets;
drop policy if exists "fleets_delete_scope" on public.fleets;

create policy "fleets_insert_scope"
on public.fleets
for insert
to authenticated
with check (
  public.is_staff(auth.uid())
  or exists (
    select 1
    from public.agency_memberships am
    where am.user_id = auth.uid()
      and am.agency_id = fleets.agency_id
      and am.role_in_agency in ('agency_admin', 'owner')
  )
  or exists (
    select 1
    from public.fleet_memberships fm
    join public.fleets existing_fleet
      on existing_fleet.id = fm.fleet_id
    where fm.user_id = auth.uid()
      and fm.role_in_fleet in ('fleet_admin', 'owner')
      and existing_fleet.agency_id = fleets.agency_id
  )
);

create policy "fleets_update_scope"
on public.fleets
for update
to authenticated
using (public.can_manage_fleet(fleets.id))
with check (public.can_manage_fleet(fleets.id));

create policy "fleets_delete_scope"
on public.fleets
for delete
to authenticated
using (public.can_manage_fleet(fleets.id));

drop policy if exists "agency_memberships_insert_creator_scope" on public.agency_memberships;
create policy "agency_memberships_insert_creator_scope"
on public.agency_memberships
for insert
to authenticated
with check (
  public.is_staff(auth.uid())
  or (
    agency_memberships.user_id = auth.uid()
    and exists (
      select 1
      from public.agencies a
      where a.id = agency_memberships.agency_id
        and a.created_by = auth.uid()
    )
  )
);

drop policy if exists "platform_invites_scope" on public.platform_invites;
drop policy if exists "platform_invites_manage_staff" on public.platform_invites;
drop policy if exists "platform_invites_insert_scope" on public.platform_invites;

create policy "platform_invites_manage_staff"
on public.platform_invites
for all
to authenticated
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

create policy "platform_invites_insert_scope"
on public.platform_invites
for insert
to authenticated
with check (
  platform_invites.invited_by = auth.uid()
  and upper(coalesce(platform_invites.target_role, '')) in ('FLEET', 'DRIVER')
  and (
    public.is_staff(auth.uid())
    or (
      platform_invites.agency_id is not null
      and exists (
        select 1
        from public.agency_memberships am
        where am.user_id = auth.uid()
          and am.agency_id = platform_invites.agency_id
          and am.role_in_agency in ('agency_admin', 'owner')
      )
    )
    or (
      platform_invites.fleet_id is not null
      and exists (
        select 1
        from public.fleet_memberships fm
        where fm.user_id = auth.uid()
          and fm.fleet_id = platform_invites.fleet_id
          and fm.role_in_fleet in ('fleet_admin', 'owner')
      )
    )
    or (
      platform_invites.agency_id is not null
      and exists (
        select 1
        from public.fleet_memberships fm
        join public.fleets f
          on f.id = fm.fleet_id
        where fm.user_id = auth.uid()
          and fm.role_in_fleet in ('fleet_admin', 'owner')
          and f.agency_id = platform_invites.agency_id
      )
    )
  )
);
