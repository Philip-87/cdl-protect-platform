-- Hotfix: remove ON CONFLICT dependency from claim_my_invites profile bootstrap.
-- Safe to run multiple times.

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

  update public.profiles p
  set user_id = coalesce(p.user_id, uid),
      email = coalesce(p.email, email_value)
  where p.id = uid
     or p.user_id = uid;

  if not found then
    begin
      insert into public.profiles (id, user_id, email, system_role)
      values (uid, uid, email_value, 'NONE');
    exception when unique_violation then
      update public.profiles p
      set user_id = coalesce(p.user_id, uid),
          email = coalesce(p.email, email_value)
      where p.id = uid
         or p.user_id = uid;
    end;
  end if;

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

    update public.profiles p
    set system_role = target_role_value
    where (p.id = uid or p.user_id = uid)
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

revoke all on function public.claim_my_invites() from public;
grant execute on function public.claim_my_invites() to authenticated;
