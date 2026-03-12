-- Allow self-bootstrap profile inserts and add fleet archive flag.
-- Safe to run multiple times.

alter table if exists public.fleets
  add column if not exists is_active boolean not null default true;

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (
  id = auth.uid()
  or user_id = auth.uid()
);

