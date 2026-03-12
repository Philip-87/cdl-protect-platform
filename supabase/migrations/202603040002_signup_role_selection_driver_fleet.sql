-- Allow self-signup users to start as DRIVER or FLEET via auth metadata.
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
begin
  requested_role := upper(coalesce(new.raw_user_meta_data ->> 'requested_role', 'NONE'));
  if requested_role not in ('DRIVER', 'FLEET') then
    requested_role := 'NONE';
  end if;

  update public.profiles p
  set user_id = coalesce(p.user_id, new.id),
      email = coalesce(nullif(p.email, ''), new.email),
      full_name = coalesce(
        nullif(p.full_name, ''),
        coalesce(new.raw_user_meta_data ->> 'full_name', new.email)
      ),
      system_role = case
        when upper(coalesce(p.system_role, 'NONE')) = 'NONE' then requested_role
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
        coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
        requested_role
      );
    exception
      when unique_violation then
        update public.profiles p
        set user_id = coalesce(p.user_id, new.id),
            email = coalesce(nullif(p.email, ''), new.email),
            full_name = coalesce(
              nullif(p.full_name, ''),
              coalesce(new.raw_user_meta_data ->> 'full_name', new.email)
            ),
            system_role = case
              when upper(coalesce(p.system_role, 'NONE')) = 'NONE' then requested_role
              else p.system_role
            end
        where p.id = new.id
           or p.user_id = new.id;
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user_profile();
