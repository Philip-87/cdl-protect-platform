-- Traffic ticket platform baseline schema, RLS, and storage policies.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  system_role text not null default 'NONE' check (system_role in ('NONE', 'AGENT', 'ADMIN')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete set null,
  state text not null check (char_length(state) = 2),
  county text,
  citation_number text not null,
  violation_code text,
  court_date date,
  status text not null default 'INTAKE' check (status in ('INTAKE', 'REVIEW', 'FILED', 'RESOLVED')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  doc_type text not null default 'OTHER',
  filename text,
  storage_path text unique,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_cases_owner_id on public.cases (owner_id);
create index if not exists idx_cases_created_at on public.cases (created_at desc);
create index if not exists idx_documents_case_id on public.documents (case_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.is_staff(user_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = user_id
      and p.system_role in ('AGENT', 'ADMIN')
  );
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user_profile();

alter table public.profiles enable row level security;
alter table public.cases enable row level security;
alter table public.documents enable row level security;

drop policy if exists "profiles_select_self_or_staff" on public.profiles;
create policy "profiles_select_self_or_staff"
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "cases_select_owner_or_staff" on public.cases;
create policy "cases_select_owner_or_staff"
on public.cases
for select
to authenticated
using (owner_id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "cases_insert_owner_or_staff" on public.cases;
create policy "cases_insert_owner_or_staff"
on public.cases
for insert
to authenticated
with check (owner_id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "cases_update_owner_or_staff" on public.cases;
create policy "cases_update_owner_or_staff"
on public.cases
for update
to authenticated
using (owner_id = auth.uid() or public.is_staff(auth.uid()))
with check (owner_id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "cases_delete_owner_or_staff" on public.cases;
create policy "cases_delete_owner_or_staff"
on public.cases
for delete
to authenticated
using (owner_id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "documents_select_case_scope" on public.documents;
create policy "documents_select_case_scope"
on public.documents
for select
to authenticated
using (
  exists (
    select 1
    from public.cases c
    where c.id = documents.case_id
      and (c.owner_id = auth.uid() or public.is_staff(auth.uid()))
  )
);

drop policy if exists "documents_insert_case_scope" on public.documents;
create policy "documents_insert_case_scope"
on public.documents
for insert
to authenticated
with check (
  uploaded_by = auth.uid()
  and exists (
    select 1
    from public.cases c
    where c.id = documents.case_id
      and (c.owner_id = auth.uid() or public.is_staff(auth.uid()))
  )
);

drop policy if exists "documents_delete_case_scope" on public.documents;
create policy "documents_delete_case_scope"
on public.documents
for delete
to authenticated
using (
  exists (
    select 1
    from public.cases c
    where c.id = documents.case_id
      and (c.owner_id = auth.uid() or public.is_staff(auth.uid()))
  )
);

insert into storage.buckets (id, name, public)
values ('case-documents', 'case-documents', false)
on conflict (id) do nothing;

drop policy if exists "storage_case_docs_insert" on storage.objects;
create policy "storage_case_docs_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'case-documents'
  and exists (
    select 1
    from public.cases c
    where c.id::text = split_part(name, '/', 1)
      and (c.owner_id = auth.uid() or public.is_staff(auth.uid()))
  )
);

drop policy if exists "storage_case_docs_select" on storage.objects;
create policy "storage_case_docs_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'case-documents'
  and exists (
    select 1
    from public.cases c
    where c.id::text = split_part(name, '/', 1)
      and (c.owner_id = auth.uid() or public.is_staff(auth.uid()))
  )
);

drop policy if exists "storage_case_docs_delete" on storage.objects;
create policy "storage_case_docs_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'case-documents'
  and exists (
    select 1
    from public.cases c
    where c.id::text = split_part(name, '/', 1)
      and (c.owner_id = auth.uid() or public.is_staff(auth.uid()))
  )
);
