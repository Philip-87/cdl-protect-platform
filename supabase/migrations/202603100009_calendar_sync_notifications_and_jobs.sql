alter table public.job_queue drop constraint if exists job_queue_job_type_check;
alter table public.job_queue add constraint job_queue_job_type_check
check (
  job_type in (
    'OCR_PROCESS_DOCUMENT',
    'ESCALATE_UNACCEPTED_OFFER',
    'REMIND_CLIENT_DOCS',
    'REMIND_COURT_DATE',
    'NUDGE_ATTORNEY_UPDATE',
    'REMIND_PAYMENT_DUE',
    'DELIVER_EVENT_REMINDER',
    'SYNC_CALENDAR_IMPORT',
    'SYNC_CALENDAR_EXPORT'
  )
);

create table if not exists public.attorney_calendar_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  provider_account_email text,
  provider_calendar_id text not null default 'primary',
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  granted_scopes text[] not null default '{}'::text[],
  sync_enabled boolean not null default true,
  import_external_events boolean not null default true,
  export_platform_events boolean not null default true,
  sync_direction text not null default 'BIDIRECTIONAL',
  last_sync_at timestamptz,
  last_sync_status text not null default 'CONNECTED',
  last_sync_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attorney_calendar_integrations_provider_check
    check (provider in ('GOOGLE', 'MICROSOFT')),
  constraint attorney_calendar_integrations_sync_direction_check
    check (sync_direction in ('BIDIRECTIONAL', 'IMPORT_ONLY', 'EXPORT_ONLY')),
  constraint attorney_calendar_integrations_status_check
    check (last_sync_status in ('CONNECTED', 'PENDING', 'ERROR', 'DISCONNECTED')),
  constraint attorney_calendar_integrations_user_provider_unique unique (user_id, provider)
);

create index if not exists idx_attorney_calendar_integrations_user
  on public.attorney_calendar_integrations (user_id, provider);

create index if not exists idx_attorney_calendar_integrations_sync
  on public.attorney_calendar_integrations (sync_enabled, last_sync_status, updated_at desc);

drop trigger if exists trg_attorney_calendar_integrations_updated_at on public.attorney_calendar_integrations;
create trigger trg_attorney_calendar_integrations_updated_at
before update on public.attorney_calendar_integrations
for each row
execute function public.set_updated_at();

create table if not exists public.attorney_calendar_external_events (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.attorney_calendar_integrations (id) on delete cascade,
  provider text not null,
  external_event_id text not null,
  external_calendar_id text not null default 'primary',
  platform_event_kind text not null,
  platform_event_key text not null,
  sync_direction text not null default 'EXPORT',
  provider_event_hash text,
  platform_event_hash text,
  remote_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attorney_calendar_external_events_provider_check
    check (provider in ('GOOGLE', 'MICROSOFT')),
  constraint attorney_calendar_external_events_kind_check
    check (platform_event_kind in ('calendar', 'task', 'case_court')),
  constraint attorney_calendar_external_events_direction_check
    check (sync_direction in ('IMPORT', 'EXPORT', 'BIDIRECTIONAL')),
  constraint attorney_calendar_external_events_external_unique unique (integration_id, external_event_id),
  constraint attorney_calendar_external_events_platform_unique unique (integration_id, platform_event_key)
);

create index if not exists idx_attorney_calendar_external_events_platform
  on public.attorney_calendar_external_events (platform_event_key, last_synced_at desc);

create index if not exists idx_attorney_calendar_external_events_integration
  on public.attorney_calendar_external_events (integration_id, last_synced_at desc);

drop trigger if exists trg_attorney_calendar_external_events_updated_at on public.attorney_calendar_external_events;
create trigger trg_attorney_calendar_external_events_updated_at
before update on public.attorney_calendar_external_events
for each row
execute function public.set_updated_at();

create table if not exists public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  case_id uuid references public.cases (id) on delete cascade,
  category text not null,
  title text not null,
  body text not null,
  href text,
  read_at timestamptz,
  delivered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_in_app_notifications_user
  on public.in_app_notifications (user_id, read_at, created_at desc);

create index if not exists idx_in_app_notifications_case
  on public.in_app_notifications (case_id, created_at desc);

drop trigger if exists trg_in_app_notifications_updated_at on public.in_app_notifications;
create trigger trg_in_app_notifications_updated_at
before update on public.in_app_notifications
for each row
execute function public.set_updated_at();

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.in_app_notifications (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  channel text not null,
  status text not null,
  delivery_key text,
  sent_at timestamptz,
  failed_at timestamptz,
  error_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_channel_check
    check (channel in ('IN_APP', 'EMAIL')),
  constraint notification_deliveries_status_check
    check (status in ('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED'))
);

create unique index if not exists idx_notification_deliveries_key
  on public.notification_deliveries (delivery_key)
  where delivery_key is not null;

create index if not exists idx_notification_deliveries_notification
  on public.notification_deliveries (notification_id, channel);

create index if not exists idx_notification_deliveries_user
  on public.notification_deliveries (user_id, created_at desc);

drop trigger if exists trg_notification_deliveries_updated_at on public.notification_deliveries;
create trigger trg_notification_deliveries_updated_at
before update on public.notification_deliveries
for each row
execute function public.set_updated_at();

alter table public.attorney_calendar_integrations enable row level security;
alter table public.attorney_calendar_external_events enable row level security;
alter table public.in_app_notifications enable row level security;
alter table public.notification_deliveries enable row level security;

drop policy if exists "attorney_calendar_integrations_select_scope" on public.attorney_calendar_integrations;
create policy "attorney_calendar_integrations_select_scope"
on public.attorney_calendar_integrations
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

drop policy if exists "attorney_calendar_integrations_manage_scope" on public.attorney_calendar_integrations;
create policy "attorney_calendar_integrations_manage_scope"
on public.attorney_calendar_integrations
for all
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
)
with check (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

drop policy if exists "attorney_calendar_external_events_select_scope" on public.attorney_calendar_external_events;
create policy "attorney_calendar_external_events_select_scope"
on public.attorney_calendar_external_events
for select
to authenticated
using (
  exists (
    select 1
    from public.attorney_calendar_integrations i
    where i.id = attorney_calendar_external_events.integration_id
      and (
        i.user_id = auth.uid()
        or public.is_staff(auth.uid())
      )
  )
);

drop policy if exists "attorney_calendar_external_events_manage_scope" on public.attorney_calendar_external_events;
create policy "attorney_calendar_external_events_manage_scope"
on public.attorney_calendar_external_events
for all
to authenticated
using (
  exists (
    select 1
    from public.attorney_calendar_integrations i
    where i.id = attorney_calendar_external_events.integration_id
      and (
        i.user_id = auth.uid()
        or public.is_staff(auth.uid())
      )
  )
)
with check (
  exists (
    select 1
    from public.attorney_calendar_integrations i
    where i.id = attorney_calendar_external_events.integration_id
      and (
        i.user_id = auth.uid()
        or public.is_staff(auth.uid())
      )
  )
);

drop policy if exists "in_app_notifications_select_scope" on public.in_app_notifications;
create policy "in_app_notifications_select_scope"
on public.in_app_notifications
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

drop policy if exists "in_app_notifications_update_scope" on public.in_app_notifications;
create policy "in_app_notifications_update_scope"
on public.in_app_notifications
for update
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
)
with check (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);

drop policy if exists "notification_deliveries_select_scope" on public.notification_deliveries;
create policy "notification_deliveries_select_scope"
on public.notification_deliveries
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_staff(auth.uid())
);
