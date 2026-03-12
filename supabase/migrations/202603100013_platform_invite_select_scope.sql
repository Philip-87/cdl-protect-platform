-- Allow agency and fleet managers to view open invites inside their workspace scope.
-- Safe to run multiple times.

drop policy if exists "platform_invites_select_self" on public.platform_invites;
drop policy if exists "platform_invites_select_scope" on public.platform_invites;

create policy "platform_invites_select_scope"
on public.platform_invites
for select
to authenticated
using (
  public.is_staff(auth.uid())
  or lower(platform_invites.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  or (
    upper(coalesce(platform_invites.target_role, '')) = 'AGENCY'
    and platform_invites.agency_id is not null
    and exists (
      select 1
      from public.agency_memberships am
      where am.user_id = auth.uid()
        and am.agency_id = platform_invites.agency_id
        and am.role_in_agency in ('agency_admin', 'owner')
    )
  )
  or (
    upper(coalesce(platform_invites.target_role, '')) in ('FLEET', 'DRIVER')
    and (
      (
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
  )
);
