-- Restrict driver case access to cases linked to the driver's own email.
-- Safe to run multiple times.

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
  profile_role text := 'NONE';
  normalized_email text := '';
begin
  uid := auth.uid();
  if uid is null then
    return false;
  end if;

  if public.is_staff(uid) then
    return exists (select 1 from public.cases c where c.id = target_case_id);
  end if;

  select
    upper(coalesce(p.system_role::text, 'NONE')),
    lower(
      coalesce(
        nullif(d.email, ''),
        nullif(p.email, ''),
        nullif(auth.jwt() ->> 'email', ''),
        ''
      )
    )
  into profile_role, normalized_email
  from public.profiles p
  left join public.drivers d
    on d.user_id = uid
    or d.id = uid
  where p.id = uid or p.user_id = uid
  order by case when p.id = uid then 0 else 1 end
  limit 1;

  if profile_role = 'DRIVER' then
    return exists (
      select 1
      from public.cases c
      where c.id = target_case_id
        and (
          c.owner_id = uid
          or c.driver_id = uid
          or (normalized_email <> '' and lower(coalesce(c.submitter_email, '')) = normalized_email)
          or (normalized_email <> '' and lower(coalesce(c.metadata ->> 'email', '')) = normalized_email)
        )
    );
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

revoke all on function public.can_access_case(uuid) from public;
grant execute on function public.can_access_case(uuid) to authenticated;
