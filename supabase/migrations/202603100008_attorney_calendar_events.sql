create table if not exists public.attorney_calendar_events (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid references public.attorney_firms (id) on delete set null,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  assigned_user_id uuid references auth.users (id) on delete set null,
  case_id uuid references public.cases (id) on delete set null,
  title text not null,
  event_type text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  location text,
  virtual_meeting_url text,
  visibility text not null default 'SHARED',
  status text not null default 'SCHEDULED',
  notes text,
  linked_court text,
  linked_state text,
  linked_county text,
  prep_before_minutes integer not null default 0,
  travel_before_minutes integer not null default 0,
  travel_after_minutes integer not null default 0,
  reminder_offsets jsonb,
  recurrence_rule jsonb,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attorney_calendar_events_visibility_check check (visibility in ('PRIVATE', 'SHARED')),
  constraint attorney_calendar_events_status_check check (status in ('SCHEDULED', 'TENTATIVE', 'COMPLETED', 'CANCELLED')),
  constraint attorney_calendar_events_time_check check (end_at >= start_at)
);

create index if not exists idx_attorney_calendar_events_time
  on public.attorney_calendar_events (start_at, end_at);

create index if not exists idx_attorney_calendar_events_owner
  on public.attorney_calendar_events (owner_user_id, start_at desc);

create index if not exists idx_attorney_calendar_events_assigned
  on public.attorney_calendar_events (assigned_user_id, start_at desc);

create index if not exists idx_attorney_calendar_events_case
  on public.attorney_calendar_events (case_id, start_at desc);

create index if not exists idx_attorney_calendar_events_firm
  on public.attorney_calendar_events (firm_id, start_at desc);

drop trigger if exists trg_attorney_calendar_events_updated_at on public.attorney_calendar_events;
create trigger trg_attorney_calendar_events_updated_at
before update on public.attorney_calendar_events
for each row
execute function public.set_updated_at();

alter table public.attorney_calendar_events enable row level security;

drop policy if exists "attorney_calendar_events_select_scope" on public.attorney_calendar_events;
create policy "attorney_calendar_events_select_scope"
on public.attorney_calendar_events
for select
to authenticated
using (
  public.is_staff(auth.uid())
  or owner_user_id = auth.uid()
  or assigned_user_id = auth.uid()
  or (
    case_id is not null
    and public.can_access_case(case_id)
  )
  or (
    firm_id is not null
    and exists (
      select 1
      from public.attorney_firm_memberships afm
      where afm.firm_id = attorney_calendar_events.firm_id
        and afm.user_id = auth.uid()
    )
  )
);

drop policy if exists "attorney_calendar_events_manage_scope" on public.attorney_calendar_events;
create policy "attorney_calendar_events_manage_scope"
on public.attorney_calendar_events
for all
to authenticated
using (
  public.is_staff(auth.uid())
  or owner_user_id = auth.uid()
  or assigned_user_id = auth.uid()
  or (
    case_id is not null
    and public.can_access_case(case_id)
  )
  or (
    firm_id is not null
    and exists (
      select 1
      from public.attorney_firm_memberships afm
      where afm.firm_id = attorney_calendar_events.firm_id
        and afm.user_id = auth.uid()
    )
  )
)
with check (
  public.is_staff(auth.uid())
  or owner_user_id = auth.uid()
  or assigned_user_id = auth.uid()
  or (
    case_id is not null
    and public.can_access_case(case_id)
  )
  or (
    firm_id is not null
    and exists (
      select 1
      from public.attorney_firm_memberships afm
      where afm.firm_id = attorney_calendar_events.firm_id
        and afm.user_id = auth.uid()
    )
  )
);
