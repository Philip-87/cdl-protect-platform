-- Hotfix migration: resolve legacy function ambiguity and auto-claim role invites.
-- Safe to run multiple times.

create extension if not exists pgcrypto;

-- Ensure staff helper is unambiguous across legacy schemas.
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

-- Ensure case access helper references the current role model.
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

-- Auto-claim pending invites for the logged-in user and attach memberships.
create or replace function public.claim_my_invites()
returns integer
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  email_value text;
  invite_row record;
  applied_count integer := 0;
  target_role_value text;
begin
  uid := auth.uid();
  if uid is null then
    return 0;
  end if;

  email_value := lower(coalesce(auth.jwt() ->> 'email', ''));
  if email_value = '' then
    return 0;
  end if;

  insert into public.profiles (id, user_id, email, system_role)
  values (uid, uid, email_value, 'NONE')
  on conflict (id) do update
    set user_id = coalesce(public.profiles.user_id, excluded.user_id),
        email = coalesce(public.profiles.email, excluded.email);

  for invite_row in
    select i.id, i.target_role, i.agency_id, i.fleet_id, i.firm_id
    from public.platform_invites i
    where lower(i.email) = email_value
      and i.accepted_at is null
      and i.expires_at > now()
    order by i.created_at asc
  loop
    target_role_value := upper(coalesce(invite_row.target_role::text, 'NONE'));
    if target_role_value not in ('NONE', 'DRIVER', 'FLEET', 'AGENCY', 'ATTORNEY', 'ADMIN', 'OPS', 'AGENT') then
      target_role_value := 'NONE';
    end if;

    -- Only auto-assign role when current role is NONE (avoid unintentional downgrades).
    update public.profiles p
    set system_role = target_role_value
    where p.id = uid
      and upper(coalesce(p.system_role::text, 'NONE')) = 'NONE'
      and target_role_value <> 'NONE';

    if invite_row.agency_id is not null and target_role_value in ('AGENCY', 'FLEET', 'DRIVER') then
      insert into public.agency_memberships (agency_id, user_id, role_in_agency)
      values (
        invite_row.agency_id,
        uid,
        case
          when target_role_value = 'AGENCY' then 'agency_admin'
          else 'member'
        end
      )
      on conflict (agency_id, user_id) do nothing;
    end if;

    if invite_row.fleet_id is not null and target_role_value in ('FLEET', 'DRIVER') then
      insert into public.fleet_memberships (fleet_id, user_id, role_in_fleet)
      values (
        invite_row.fleet_id,
        uid,
        case
          when target_role_value = 'FLEET' then 'fleet_admin'
          else 'member'
        end
      )
      on conflict (fleet_id, user_id) do nothing;
    end if;

    if invite_row.firm_id is not null and target_role_value = 'ATTORNEY' then
      insert into public.attorney_firm_memberships (firm_id, user_id, role_in_firm)
      values (invite_row.firm_id, uid, 'attorney_admin')
      on conflict (firm_id, user_id) do nothing;
    end if;

    update public.platform_invites
    set accepted_at = now()
    where id = invite_row.id
      and accepted_at is null;

    applied_count := applied_count + 1;
  end loop;

  return applied_count;
end;
$$;

revoke all on function public.is_staff(uuid) from public;
revoke all on function public.can_access_case(uuid) from public;
revoke all on function public.can_access_case(text) from public;
revoke all on function public.claim_my_invites() from public;

grant execute on function public.is_staff(uuid) to authenticated;
grant execute on function public.can_access_case(uuid) to authenticated;
grant execute on function public.can_access_case(text) to authenticated;
grant execute on function public.claim_my_invites() to authenticated;
