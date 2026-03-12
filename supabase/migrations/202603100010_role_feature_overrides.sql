create table if not exists public.platform_role_feature_overrides (
  id uuid primary key default gen_random_uuid(),
  role text not null,
  feature_key text not null,
  is_enabled boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (role, feature_key)
);

create index if not exists platform_role_feature_overrides_role_idx
  on public.platform_role_feature_overrides(role);

create index if not exists platform_role_feature_overrides_feature_idx
  on public.platform_role_feature_overrides(feature_key);

create or replace function public.set_platform_role_feature_overrides_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_platform_role_feature_overrides_updated_at
  on public.platform_role_feature_overrides;
create trigger trg_platform_role_feature_overrides_updated_at
before update on public.platform_role_feature_overrides
for each row execute function public.set_platform_role_feature_overrides_updated_at();

alter table public.platform_role_feature_overrides enable row level security;

drop policy if exists "platform_role_feature_overrides_authenticated_select"
  on public.platform_role_feature_overrides;
create policy "platform_role_feature_overrides_authenticated_select"
on public.platform_role_feature_overrides
for select
to authenticated
using (true);

drop policy if exists "platform_role_feature_overrides_staff_manage"
  on public.platform_role_feature_overrides;
create policy "platform_role_feature_overrides_staff_manage"
on public.platform_role_feature_overrides
for all
to authenticated
using (public.current_user_is_staff())
with check (public.current_user_is_staff());
