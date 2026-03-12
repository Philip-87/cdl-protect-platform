-- Enable agency self-signup metadata and scoped agency teammate invites.
-- Safe to run multiple times.

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  requested_role text;
  resolved_full_name text;
  resolved_first_name text;
  resolved_last_name text;
begin
  requested_role := upper(coalesce(new.raw_user_meta_data ->> 'requested_role', 'NONE'));
  if requested_role not in ('DRIVER', 'FLEET', 'AGENCY') then
    requested_role := 'NONE';
  end if;

  resolved_full_name := coalesce(new.raw_user_meta_data ->> 'full_name', new.email);
  resolved_first_name := nullif(split_part(coalesce(resolved_full_name, ''), ' ', 1), '');
  resolved_last_name := nullif(trim(substr(coalesce(resolved_full_name, ''), length(coalesce(resolved_first_name, '')) + 1)), '');

  update public.profiles p
  set user_id = coalesce(p.user_id, new.id),
      email = coalesce(nullif(p.email, ''), new.email),
      full_name = coalesce(nullif(p.full_name, ''), resolved_full_name),
      system_role = case
        when upper(coalesce(p.system_role, 'NONE')) = 'NONE' and requested_role in ('DRIVER', 'FLEET', 'AGENCY') then requested_role
        else p.system_role
      end
  where p.id = new.id
     or p.user_id = new.id;

  if not found then
    begin
      insert into public.profiles (id, user_id, email, full_name, system_role)
      values (
        new.id,
        new.id,
        new.email,
        resolved_full_name,
        requested_role
      );
    exception
      when unique_violation then
        update public.profiles p
        set user_id = coalesce(p.user_id, new.id),
            email = coalesce(nullif(p.email, ''), new.email),
            full_name = coalesce(nullif(p.full_name, ''), resolved_full_name),
            system_role = case
              when upper(coalesce(p.system_role, 'NONE')) = 'NONE' and requested_role in ('DRIVER', 'FLEET', 'AGENCY') then requested_role
              else p.system_role
            end
        where p.id = new.id
           or p.user_id = new.id;
    end;
  end if;

  if requested_role = 'DRIVER' and to_regclass('public.drivers') is not null then
    begin
      insert into public.drivers (id, user_id, email, first_name, last_name)
      values (new.id, new.id, new.email, resolved_first_name, resolved_last_name)
      on conflict (user_id) do update
      set email = coalesce(public.drivers.email, excluded.email),
          first_name = coalesce(public.drivers.first_name, excluded.first_name),
          last_name = coalesce(public.drivers.last_name, excluded.last_name);
    exception
      when undefined_table then
        null;
      when others then
        null;
    end;
  end if;

  return new;
end;
$$;

drop policy if exists "platform_invites_insert_scope" on public.platform_invites;
create policy "platform_invites_insert_scope"
on public.platform_invites
for insert
to authenticated
with check (
  platform_invites.invited_by = auth.uid()
  and (
    public.is_staff(auth.uid())
    or (
      upper(coalesce(platform_invites.target_role, '')) = 'AGENCY'
      and platform_invites.agency_id is not null
      and platform_invites.fleet_id is null
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
  )
);
