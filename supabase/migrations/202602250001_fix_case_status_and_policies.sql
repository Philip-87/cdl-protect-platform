-- Repair legacy schema drift and conflicting RLS policies.
-- Safe to run multiple times.

create extension if not exists pgcrypto;

-- Base tables are created by 202602240001_traffic_ticket_platform.sql.
-- This migration intentionally only applies schema repairs, role/policy fixes, and helper functions.

-- Ensure required columns exist, even on legacy tables.
alter table public.profiles add column if not exists id uuid;
alter table public.profiles add column if not exists user_id uuid;
alter table public.profiles add column if not exists system_role text;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists created_at timestamptz default now();
alter table public.profiles add column if not exists updated_at timestamptz default now();

alter table public.cases add column if not exists owner_id uuid;
alter table public.cases add column if not exists status text;
alter table public.cases add column if not exists metadata jsonb;
alter table public.cases add column if not exists updated_at timestamptz default now();
alter table public.cases add column if not exists created_at timestamptz default now();

alter table public.documents add column if not exists ocr_status text;
alter table public.documents add column if not exists ocr_confidence numeric;
alter table public.documents add column if not exists ocr_extracted jsonb;
alter table public.documents add column if not exists ocr_payload jsonb;

-- Backfill profiles.id from user_id when possible.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'user_id'
  ) then
    execute $sql$
      update public.profiles
      set id = case
        when user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then user_id::text::uuid
        else id
      end
      where id is null
    $sql$;
  end if;
end $$;

-- Backfill cases.owner_id from legacy columns when possible.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'cases' and column_name = 'user_id'
  ) then
    execute $sql$
      update public.cases
      set owner_id = case
        when user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then user_id::text::uuid
        else owner_id
      end
      where owner_id is null
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'cases' and column_name = 'created_by'
  ) then
    execute $sql$
      update public.cases
      set owner_id = case
        when created_by::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then created_by::text::uuid
        else owner_id
      end
      where owner_id is null
    $sql$;
  end if;
end $$;

-- Normalize legacy driver_id constraints to avoid blocking inserts.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'cases' and column_name = 'driver_id'
  ) then
    begin
      execute 'update public.cases set driver_id = owner_id where driver_id is null and owner_id is not null';
    exception when others then null;
    end;

    begin
      execute $sql$
        update public.cases
        set driver_id = user_id::text::uuid
        where driver_id is null
          and user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      $sql$;
    exception when others then null;
    end;

    begin
      execute $sql$
        update public.cases
        set driver_id = created_by::text::uuid
        where driver_id is null
          and created_by::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      $sql$;
    exception when others then null;
    end;

    begin
      execute 'alter table public.cases alter column driver_id drop not null';
    exception when others then null;
    end;
  end if;
end $$;

-- Rebuild status semantics.
do $$
declare
  c record;
  status_udt text;
  intake_label text;
begin
  begin
    execute 'alter table public.cases alter column status drop default';
  exception when others then null;
  end;

  begin
    execute 'alter table public.cases alter column status type text using upper(status::text)';
  exception when others then null;
  end;

  begin
    execute $sql$
      update public.cases
      set status = case
        when upper(status::text) in ('INTAKE', 'NEW', 'OPEN', 'PENDING') then 'INTAKE'
        when upper(status::text) in ('REVIEW', 'IN_REVIEW', 'UNDER_REVIEW') then 'REVIEW'
        when upper(status::text) in ('FILED', 'SUBMITTED') then 'FILED'
        when upper(status::text) in ('RESOLVED', 'CLOSED', 'COMPLETE', 'COMPLETED') then 'RESOLVED'
        else 'INTAKE'
      end
    $sql$;
  exception
    when datatype_mismatch then
      execute $sql$
        with enum_values as (
          select enumlabel
          from pg_enum
          where enumtypid = 'case_status'::regtype
        )
        update public.cases
        set status = case
          when upper(status::text) in ('INTAKE', 'NEW', 'OPEN', 'PENDING') then
            coalesce(
              (select enumlabel from enum_values where upper(enumlabel) = 'INTAKE' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'NEW' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'OPEN' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'PENDING' limit 1),
              status::text
            )::case_status
          when upper(status::text) in ('REVIEW', 'IN_REVIEW', 'UNDER_REVIEW') then
            coalesce(
              (select enumlabel from enum_values where upper(enumlabel) = 'REVIEW' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'IN_REVIEW' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'UNDER_REVIEW' limit 1),
              status::text
            )::case_status
          when upper(status::text) in ('FILED', 'SUBMITTED') then
            coalesce(
              (select enumlabel from enum_values where upper(enumlabel) = 'FILED' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'SUBMITTED' limit 1),
              status::text
            )::case_status
          when upper(status::text) in ('RESOLVED', 'CLOSED', 'COMPLETE', 'COMPLETED') then
            coalesce(
              (select enumlabel from enum_values where upper(enumlabel) = 'RESOLVED' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'CLOSED' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'COMPLETE' limit 1),
              (select enumlabel from enum_values where upper(enumlabel) = 'COMPLETED' limit 1),
              status::text
            )::case_status
          else
            coalesce(
              (select enumlabel from enum_values where upper(enumlabel) = 'INTAKE' limit 1),
              status::text
            )::case_status
        end
      $sql$;
  end;

  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.cases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.cases drop constraint if exists %I', c.conname);
  end loop;

  select cols.udt_name
  into status_udt
  from information_schema.columns cols
  where cols.table_schema = 'public'
    and cols.table_name = 'cases'
    and cols.column_name = 'status';

  execute 'alter table public.cases alter column status set not null';

  if status_udt = 'case_status' then
    select coalesce(
      (select e.enumlabel from pg_enum e where e.enumtypid = 'case_status'::regtype and upper(e.enumlabel) = 'INTAKE' limit 1),
      (select e.enumlabel from pg_enum e where e.enumtypid = 'case_status'::regtype order by e.enumsortorder limit 1)
    )
    into intake_label;

    if intake_label is not null then
      execute format(
        'alter table public.cases alter column status set default %L::case_status',
        intake_label
      );
    else
      execute 'alter table public.cases alter column status drop default';
    end if;
  else
    execute 'alter table public.cases alter column status set default ''INTAKE''';
    execute 'alter table public.cases add constraint cases_status_check check (status in (''INTAKE'', ''REVIEW'', ''FILED'', ''RESOLVED''))';
  end if;
end $$;

-- Normalize profiles.system_role.
do $$
declare
  role_udt_schema text;
  role_udt_name text;
  role_type_ref text;
  none_label text;
begin
  select cols.udt_schema, cols.udt_name
  into role_udt_schema, role_udt_name
  from information_schema.columns cols
  where cols.table_schema = 'public'
    and cols.table_name = 'profiles'
    and cols.column_name = 'system_role';

  if role_udt_name is null then
    return;
  end if;

  if role_udt_name = 'text' then
    update public.profiles
    set system_role = 'NONE'
    where system_role is null or btrim(system_role::text) = '';

    alter table public.profiles alter column system_role set default 'NONE';
    return;
  end if;

  role_type_ref := format('%I.%I', role_udt_schema, role_udt_name);

  execute format(
    'select coalesce(
      (select enumlabel from pg_enum where enumtypid = %L::regtype and upper(enumlabel) = ''NONE'' limit 1),
      (select enumlabel from pg_enum where enumtypid = %L::regtype order by enumsortorder limit 1)
    )',
    role_type_ref,
    role_type_ref
  )
  into none_label;

  if none_label is not null then
    execute format(
      'update public.profiles
       set system_role = %L::%s
       where system_role is null or btrim(system_role::text) = ''''',
      none_label,
      role_type_ref
    );

    execute format(
      'alter table public.profiles alter column system_role set default %L::%s',
      none_label,
      role_type_ref
    );
  else
    execute 'alter table public.profiles alter column system_role drop default';
  end if;
end $$;

-- Helpful indexes.
create index if not exists idx_cases_owner_id on public.cases (owner_id);
create index if not exists idx_cases_created_at on public.cases (created_at desc);
create index if not exists idx_documents_case_id on public.documents (case_id);
create index if not exists idx_case_events_case_id_created_at on public.case_events (case_id, created_at desc);

-- Updated-at trigger.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists trg_cases_updated_at on public.cases;
create trigger trg_cases_updated_at
before update on public.cases
for each row
execute function public.set_updated_at();

-- Ensure profile creation trigger exists.
create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, user_id, email, full_name)
  values (
    new.id,
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email)
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user_profile();

-- Staff check function that works with profiles.id OR profiles.user_id.
create or replace function public.is_staff(user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  has_id boolean;
  has_user_id boolean;
  result_value boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'id'
  ) into has_id;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'user_id'
  ) into has_user_id;

  if has_id then
    execute $sql$
      select exists (
        select 1
        from public.profiles p
        where p.id = $1
          and upper(p.system_role::text) in ('AGENT', 'ADMIN')
      )
    $sql$
    into result_value
    using user_id;
    return coalesce(result_value, false);
  end if;

  if has_user_id then
    execute $sql$
      select exists (
        select 1
        from public.profiles p
        where p.user_id = $1
          and upper(p.system_role::text) in ('AGENT', 'ADMIN')
      )
    $sql$
    into result_value
    using user_id;
    return coalesce(result_value, false);
  end if;

  return false;
end;
$$;

revoke all on function public.is_staff(uuid) from public;
grant execute on function public.is_staff(uuid) to authenticated;

-- Security-definer case access checks to avoid nested RLS recursion in policies.
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
  is_admin_or_agent boolean;
begin
  uid := auth.uid();
  if uid is null then
    return false;
  end if;

  select exists (
    select 1
    from public.profiles p
    where (p.id = uid or p.user_id = uid)
      and upper(coalesce(p.system_role::text, 'NONE')) in ('AGENT', 'ADMIN')
  )
  into is_admin_or_agent;

  return exists (
    select 1
    from public.cases c
    where c.id = target_case_id
      and (c.owner_id = uid or coalesce(is_admin_or_agent, false))
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

revoke all on function public.can_access_case(uuid) from public;
revoke all on function public.can_access_case(text) from public;
grant execute on function public.can_access_case(uuid) to authenticated;
grant execute on function public.can_access_case(text) to authenticated;

-- Drop all policies on our tables (legacy conflicting policies can recurse).
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles', 'cases', 'documents', 'case_events')
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.cases enable row level security;
alter table public.documents enable row level security;
alter table public.case_events enable row level security;

create policy "profiles_select_self_or_staff"
on public.profiles
for select
to authenticated
using (
  (id = auth.uid())
  or (user_id = auth.uid())
  or public.is_staff(auth.uid())
);

create policy "profiles_update_self"
on public.profiles
for update
to authenticated
using ((id = auth.uid()) or (user_id = auth.uid()))
with check ((id = auth.uid()) or (user_id = auth.uid()));

create policy "cases_select_owner_or_staff"
on public.cases
for select
to authenticated
using (owner_id = auth.uid() or public.is_staff(auth.uid()));

create policy "cases_insert_owner_or_staff"
on public.cases
for insert
to authenticated
with check (owner_id = auth.uid() or public.is_staff(auth.uid()));

create policy "cases_update_owner_or_staff"
on public.cases
for update
to authenticated
using (owner_id = auth.uid() or public.is_staff(auth.uid()))
with check (owner_id = auth.uid() or public.is_staff(auth.uid()));

create policy "cases_delete_owner_or_staff"
on public.cases
for delete
to authenticated
using (owner_id = auth.uid() or public.is_staff(auth.uid()));

create policy "documents_select_case_scope"
on public.documents
for select
to authenticated
using (public.can_access_case(documents.case_id));

create policy "documents_insert_case_scope"
on public.documents
for insert
to authenticated
with check (
  (uploaded_by is null or uploaded_by = auth.uid())
  and public.can_access_case(documents.case_id)
);

create policy "documents_update_case_scope"
on public.documents
for update
to authenticated
using (public.can_access_case(documents.case_id))
with check (public.can_access_case(documents.case_id));

create policy "documents_delete_case_scope"
on public.documents
for delete
to authenticated
using (public.can_access_case(documents.case_id));

create policy "case_events_select_case_scope"
on public.case_events
for select
to authenticated
using (public.can_access_case(case_events.case_id));

create policy "case_events_insert_case_scope"
on public.case_events
for insert
to authenticated
with check (
  (actor_id is null or actor_id = auth.uid())
  and public.can_access_case(case_events.case_id)
);

-- Storage bucket + storage policies for document upload/download.
insert into storage.buckets (id, name, public)
values ('case-documents', 'case-documents', false)
on conflict (id) do nothing;

-- Remove legacy storage policies that can recurse through cross-table checks.
do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
  loop
    execute format('drop policy if exists %I on storage.objects', p.policyname);
  end loop;
end $$;

create policy "storage_case_docs_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'case-documents'
);

create policy "storage_case_docs_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'case-documents'
);

create policy "storage_case_docs_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'case-documents'
);
