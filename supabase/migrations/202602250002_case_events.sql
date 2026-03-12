create extension if not exists pgcrypto;

alter table if exists public.cases add column if not exists owner_id uuid;

create or replace function public.is_staff(user_id uuid)
returns boolean
language plpgsql
stable
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
        select 1 from public.profiles p
        where p.id = $1 and coalesce(p.system_role, 'NONE') in ('AGENT', 'ADMIN')
      )
    $sql$
    into result_value
    using user_id;
    return coalesce(result_value, false);
  end if;

  if has_user_id then
    execute $sql$
      select exists (
        select 1 from public.profiles p
        where p.user_id = $1 and coalesce(p.system_role, 'NONE') in ('AGENT', 'ADMIN')
      )
    $sql$
    into result_value
    using user_id;
    return coalesce(result_value, false);
  end if;

  return false;
end;
$$;

create table if not exists public.case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  event_type text not null,
  event_summary text not null,
  metadata jsonb,
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_case_events_case_id_created_at
  on public.case_events (case_id, created_at desc);

alter table public.case_events enable row level security;

drop policy if exists "case_events_select_case_scope" on public.case_events;
create policy "case_events_select_case_scope"
on public.case_events
for select
to authenticated
using (
  exists (
    select 1
    from public.cases c
    where c.id = case_events.case_id
      and (c.owner_id = auth.uid() or public.is_staff(auth.uid()))
  )
);

drop policy if exists "case_events_insert_case_scope" on public.case_events;
create policy "case_events_insert_case_scope"
on public.case_events
for insert
to authenticated
with check (
  (actor_id is null or actor_id = auth.uid())
  and exists (
    select 1
    from public.cases c
    where c.id = case_events.case_id
      and (c.owner_id = auth.uid() or public.is_staff(auth.uid()))
  )
);
