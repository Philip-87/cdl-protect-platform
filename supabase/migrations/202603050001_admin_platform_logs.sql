-- Admin platform logs for debugging/auth/network visibility.
-- Safe to run multiple times.

create table if not exists public.platform_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  severity text not null default 'INFO',
  event_type text not null,
  source text not null,
  message text not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  target_user_id uuid references auth.users (id) on delete set null,
  request_path text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_platform_logs_created_at on public.platform_logs (created_at desc);
create index if not exists idx_platform_logs_actor on public.platform_logs (actor_user_id, created_at desc);
create index if not exists idx_platform_logs_target on public.platform_logs (target_user_id, created_at desc);
create index if not exists idx_platform_logs_type on public.platform_logs (event_type, created_at desc);

alter table public.platform_logs enable row level security;

drop policy if exists "platform_logs_staff_select" on public.platform_logs;
create policy "platform_logs_staff_select"
on public.platform_logs
for select
to authenticated
using (public.is_staff(auth.uid()));

drop policy if exists "platform_logs_staff_insert" on public.platform_logs;
create policy "platform_logs_staff_insert"
on public.platform_logs
for insert
to authenticated
with check (public.is_staff(auth.uid()));

