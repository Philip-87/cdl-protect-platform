-- Add active/archive flag to fleets for archive workflow and fleet visibility badges.
-- Safe to run multiple times.

alter table if exists public.fleets
  add column if not exists is_active boolean not null default true;

update public.fleets
set is_active = true
where is_active is null;

create index if not exists idx_fleets_is_active on public.fleets (is_active);
