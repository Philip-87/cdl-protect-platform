create table if not exists public.platform_custom_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text null,
  base_role text null,
  capability_codes jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_by uuid null,
  updated_by uuid null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists profiles_id_unique_idx on public.profiles(id);

create table if not exists public.platform_custom_role_assignments (
  id uuid primary key default gen_random_uuid(),
  custom_role_id uuid not null references public.platform_custom_roles(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (custom_role_id, profile_id)
);

create index if not exists platform_custom_roles_slug_idx on public.platform_custom_roles(slug);
create index if not exists platform_custom_role_assignments_profile_idx on public.platform_custom_role_assignments(profile_id);
create index if not exists platform_custom_role_assignments_role_idx on public.platform_custom_role_assignments(custom_role_id);

alter table public.platform_custom_roles enable row level security;
alter table public.platform_custom_role_assignments enable row level security;

drop policy if exists "platform_custom_roles_staff_select" on public.platform_custom_roles;
create policy "platform_custom_roles_staff_select"
on public.platform_custom_roles
for select
using (public.is_staff(auth.uid()));

drop policy if exists "platform_custom_roles_staff_manage" on public.platform_custom_roles;
create policy "platform_custom_roles_staff_manage"
on public.platform_custom_roles
for all
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));

drop policy if exists "platform_custom_role_assignments_staff_select" on public.platform_custom_role_assignments;
create policy "platform_custom_role_assignments_staff_select"
on public.platform_custom_role_assignments
for select
using (public.is_staff(auth.uid()));

drop policy if exists "platform_custom_role_assignments_staff_manage" on public.platform_custom_role_assignments;
create policy "platform_custom_role_assignments_staff_manage"
on public.platform_custom_role_assignments
for all
using (public.is_staff(auth.uid()))
with check (public.is_staff(auth.uid()));
