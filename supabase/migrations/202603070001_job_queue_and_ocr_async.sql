-- Phase 2: Automation backbone (Postgres job queue + worker RPCs + async OCR jobs).
-- Safe to run multiple times.

create extension if not exists pgcrypto;

create table if not exists public.job_queue (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  case_id uuid references public.cases (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING',
  priority integer not null default 100,
  max_attempts integer not null default 5,
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dead_lettered_at timestamptz,
  dedupe_key text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.job_queue add column if not exists job_type text;
alter table public.job_queue add column if not exists case_id uuid references public.cases (id) on delete cascade;
alter table public.job_queue add column if not exists document_id uuid references public.documents (id) on delete set null;
alter table public.job_queue add column if not exists payload jsonb default '{}'::jsonb;
alter table public.job_queue add column if not exists status text default 'PENDING';
alter table public.job_queue add column if not exists priority integer default 100;
alter table public.job_queue add column if not exists max_attempts integer default 5;
alter table public.job_queue add column if not exists attempts integer default 0;
alter table public.job_queue add column if not exists run_after timestamptz default now();
alter table public.job_queue add column if not exists locked_at timestamptz;
alter table public.job_queue add column if not exists locked_by text;
alter table public.job_queue add column if not exists last_error text;
alter table public.job_queue add column if not exists dead_lettered_at timestamptz;
alter table public.job_queue add column if not exists dedupe_key text;
alter table public.job_queue add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table public.job_queue add column if not exists created_at timestamptz default now();
alter table public.job_queue add column if not exists updated_at timestamptz default now();

alter table public.job_queue alter column job_type set not null;
alter table public.job_queue alter column payload set default '{}'::jsonb;
alter table public.job_queue alter column payload set not null;
alter table public.job_queue alter column status set default 'PENDING';
alter table public.job_queue alter column status set not null;
alter table public.job_queue alter column priority set default 100;
alter table public.job_queue alter column priority set not null;
alter table public.job_queue alter column max_attempts set default 5;
alter table public.job_queue alter column max_attempts set not null;
alter table public.job_queue alter column attempts set default 0;
alter table public.job_queue alter column attempts set not null;
alter table public.job_queue alter column run_after set default now();
alter table public.job_queue alter column run_after set not null;
alter table public.job_queue alter column created_at set default now();
alter table public.job_queue alter column created_at set not null;
alter table public.job_queue alter column updated_at set default now();
alter table public.job_queue alter column updated_at set not null;

alter table public.job_queue drop constraint if exists job_queue_status_check;
alter table public.job_queue add constraint job_queue_status_check
check (status in ('PENDING', 'RUNNING', 'RETRY', 'SUCCEEDED', 'DEAD'));

alter table public.job_queue drop constraint if exists job_queue_job_type_check;
alter table public.job_queue add constraint job_queue_job_type_check
check (
  job_type in (
    'OCR_PROCESS_DOCUMENT',
    'ESCALATE_UNACCEPTED_OFFER',
    'REMIND_CLIENT_DOCS',
    'REMIND_COURT_DATE',
    'NUDGE_ATTORNEY_UPDATE',
    'REMIND_PAYMENT_DUE'
  )
);

alter table public.job_queue drop constraint if exists job_queue_max_attempts_check;
alter table public.job_queue add constraint job_queue_max_attempts_check
check (max_attempts >= 1 and max_attempts <= 20);

alter table public.job_queue drop constraint if exists job_queue_attempts_check;
alter table public.job_queue add constraint job_queue_attempts_check
check (attempts >= 0);

create index if not exists idx_job_queue_ready
  on public.job_queue (status, run_after, priority, created_at);
create index if not exists idx_job_queue_case
  on public.job_queue (case_id, created_at desc);
create index if not exists idx_job_queue_document
  on public.job_queue (document_id);
create unique index if not exists idx_job_queue_dedupe_active
  on public.job_queue (dedupe_key)
  where dedupe_key is not null and status in ('PENDING', 'RUNNING', 'RETRY');

drop trigger if exists trg_job_queue_updated_at on public.job_queue;
create trigger trg_job_queue_updated_at
before update on public.job_queue
for each row
execute function public.set_updated_at();

create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.job_queue (id) on delete cascade,
  attempt_number integer not null,
  worker_id text,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_text text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table public.job_runs add column if not exists job_id uuid references public.job_queue (id) on delete cascade;
alter table public.job_runs add column if not exists attempt_number integer;
alter table public.job_runs add column if not exists worker_id text;
alter table public.job_runs add column if not exists status text;
alter table public.job_runs add column if not exists started_at timestamptz default now();
alter table public.job_runs add column if not exists finished_at timestamptz;
alter table public.job_runs add column if not exists error_text text;
alter table public.job_runs add column if not exists metadata jsonb;
alter table public.job_runs add column if not exists created_at timestamptz default now();

alter table public.job_runs alter column job_id set not null;
alter table public.job_runs alter column attempt_number set not null;
alter table public.job_runs alter column status set not null;
alter table public.job_runs alter column started_at set default now();
alter table public.job_runs alter column started_at set not null;
alter table public.job_runs alter column created_at set default now();
alter table public.job_runs alter column created_at set not null;

alter table public.job_runs drop constraint if exists job_runs_status_check;
alter table public.job_runs add constraint job_runs_status_check
check (status in ('RUNNING', 'SUCCEEDED', 'RETRY', 'DEAD', 'FAILED'));

alter table public.job_runs drop constraint if exists job_runs_attempt_number_check;
alter table public.job_runs add constraint job_runs_attempt_number_check
check (attempt_number >= 1);

alter table public.job_runs drop constraint if exists job_runs_job_attempt_unique;
alter table public.job_runs add constraint job_runs_job_attempt_unique unique (job_id, attempt_number);

create index if not exists idx_job_runs_job_id
  on public.job_runs (job_id, started_at desc);
create index if not exists idx_job_runs_status
  on public.job_runs (status, created_at desc);

alter table public.job_queue enable row level security;
alter table public.job_runs enable row level security;

drop policy if exists "job_queue_select_case_scope" on public.job_queue;
drop policy if exists "job_queue_insert_case_scope" on public.job_queue;
drop policy if exists "job_runs_select_case_scope" on public.job_runs;

create policy "job_queue_select_case_scope"
on public.job_queue
for select
to authenticated
using (
  (case_id is not null and public.can_access_case(case_id))
  or public.is_staff(auth.uid())
);

create policy "job_queue_insert_case_scope"
on public.job_queue
for insert
to authenticated
with check (
  created_by = auth.uid()
  and job_type = 'OCR_PROCESS_DOCUMENT'
  and case_id is not null
  and document_id is not null
  and public.can_access_case(case_id)
  and status = 'PENDING'
  and attempts = 0
);

create policy "job_runs_select_case_scope"
on public.job_runs
for select
to authenticated
using (
  exists (
    select 1
    from public.job_queue q
    where q.id = job_runs.job_id
      and (
        (q.case_id is not null and public.can_access_case(q.case_id))
        or public.is_staff(auth.uid())
      )
  )
);

create or replace function public.enqueue_case_job(
  p_job_type text,
  p_case_id uuid default null,
  p_document_id uuid default null,
  p_payload jsonb default '{}'::jsonb,
  p_run_after timestamptz default null,
  p_max_attempts integer default 5,
  p_priority integer default 100,
  p_dedupe_key text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid;
  normalized_type text;
  normalized_dedupe text;
  existing_job_id uuid;
  inserted_id uuid;
begin
  normalized_type := upper(trim(coalesce(p_job_type, '')));
  if normalized_type = '' then
    raise exception 'Job type is required.' using errcode = '22023';
  end if;

  uid := auth.uid();
  if uid is null and coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Authentication required to enqueue jobs.' using errcode = '42501';
  end if;

  if uid is not null and normalized_type <> 'OCR_PROCESS_DOCUMENT' then
    raise exception 'Authenticated user context can only enqueue OCR_PROCESS_DOCUMENT jobs.' using errcode = '42501';
  end if;

  if uid is not null and p_case_id is not null and not public.can_access_case(p_case_id) then
    raise exception 'CASE_ACCESS_DENIED: cannot enqueue job for case %', p_case_id using errcode = '42501';
  end if;

  normalized_dedupe := nullif(trim(coalesce(p_dedupe_key, '')), '');

  if normalized_dedupe is not null then
    select q.id
    into existing_job_id
    from public.job_queue q
    where q.dedupe_key = normalized_dedupe
      and q.status in ('PENDING', 'RUNNING', 'RETRY')
    order by q.created_at desc
    limit 1;

    if existing_job_id is not null then
      return existing_job_id;
    end if;
  end if;

  begin
    insert into public.job_queue (
      job_type,
      case_id,
      document_id,
      payload,
      status,
      priority,
      max_attempts,
      attempts,
      run_after,
      dedupe_key,
      created_by
    )
    values (
      normalized_type,
      p_case_id,
      p_document_id,
      coalesce(p_payload, '{}'::jsonb),
      'PENDING',
      greatest(1, least(coalesce(p_priority, 100), 1000)),
      greatest(1, least(coalesce(p_max_attempts, 5), 20)),
      0,
      coalesce(p_run_after, now()),
      normalized_dedupe,
      uid
    )
    returning id into inserted_id;
  exception
    when unique_violation then
      if normalized_dedupe is not null then
        select q.id
        into existing_job_id
        from public.job_queue q
        where q.dedupe_key = normalized_dedupe
          and q.status in ('PENDING', 'RUNNING', 'RETRY')
        order by q.created_at desc
        limit 1;

        if existing_job_id is not null then
          return existing_job_id;
        end if;
      end if;
      raise;
  end;

  return inserted_id;
end;
$$;

create or replace function public.claim_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_job_types text[] default null
)
returns table (
  id uuid,
  job_type text,
  case_id uuid,
  document_id uuid,
  payload jsonb,
  status text,
  priority integer,
  max_attempts integer,
  attempts integer,
  run_after timestamptz,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dead_lettered_at timestamptz,
  dedupe_key text,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  normalized_types text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Only service role may claim jobs.' using errcode = '42501';
  end if;

  if coalesce(trim(p_worker_id), '') = '' then
    raise exception 'Worker id is required.' using errcode = '22023';
  end if;

  select array_agg(upper(trim(v)))
  into normalized_types
  from unnest(coalesce(p_job_types, array[]::text[])) v
  where trim(v) <> '';

  return query
  with picked as (
    select q.id
    from public.job_queue q
    where q.status in ('PENDING', 'RETRY')
      and q.run_after <= now()
      and (
        coalesce(array_length(normalized_types, 1), 0) = 0
        or q.job_type = any(normalized_types)
      )
    order by q.priority asc, q.run_after asc, q.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.job_queue q
  set status = 'RUNNING',
      attempts = q.attempts + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      last_error = null,
      updated_at = now()
  from picked
  where q.id = picked.id
  returning
    q.id,
    q.job_type,
    q.case_id,
    q.document_id,
    q.payload,
    q.status,
    q.priority,
    q.max_attempts,
    q.attempts,
    q.run_after,
    q.locked_at,
    q.locked_by,
    q.last_error,
    q.dead_lettered_at,
    q.dedupe_key,
    q.created_by,
    q.created_at,
    q.updated_at;
end;
$$;

create or replace function public.complete_job(
  p_job_id uuid,
  p_succeeded boolean,
  p_error text default null,
  p_backoff_seconds integer default null
)
returns table (
  job_id uuid,
  final_status text,
  attempts integer,
  next_run_after timestamptz,
  dead_lettered boolean
)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  current_job public.job_queue%rowtype;
  next_backoff_seconds integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Only service role may complete jobs.' using errcode = '42501';
  end if;

  if p_job_id is null then
    raise exception 'Job id is required.' using errcode = '22023';
  end if;

  select *
  into current_job
  from public.job_queue
  where id = p_job_id
  for update;

  if not found then
    raise exception 'Job % not found.', p_job_id using errcode = 'P0002';
  end if;

  if p_succeeded then
    update public.job_queue
    set status = 'SUCCEEDED',
        locked_at = null,
        locked_by = null,
        last_error = null,
        updated_at = now()
    where id = p_job_id;
  else
    if current_job.attempts >= current_job.max_attempts then
      update public.job_queue
      set status = 'DEAD',
          locked_at = null,
          locked_by = null,
          dead_lettered_at = now(),
          last_error = left(coalesce(p_error, 'Job failed.'), 2000),
          updated_at = now()
      where id = p_job_id;
    else
      next_backoff_seconds := greatest(
        15,
        coalesce(
          p_backoff_seconds,
          power(2::numeric, least(greatest(current_job.attempts - 1, 0), 10))::integer * 30
        )
      );

      update public.job_queue
      set status = 'RETRY',
          locked_at = null,
          locked_by = null,
          run_after = now() + make_interval(secs => next_backoff_seconds),
          last_error = left(coalesce(p_error, 'Job failed.'), 2000),
          updated_at = now()
      where id = p_job_id;
    end if;
  end if;

  return query
  select
    q.id as job_id,
    q.status as final_status,
    q.attempts,
    q.run_after as next_run_after,
    (q.status = 'DEAD') as dead_lettered
  from public.job_queue q
  where q.id = p_job_id;
end;
$$;

revoke all on function public.enqueue_case_job(text, uuid, uuid, jsonb, timestamptz, integer, integer, text) from public;
revoke all on function public.claim_jobs(text, integer, text[]) from public;
revoke all on function public.complete_job(uuid, boolean, text, integer) from public;

grant execute on function public.enqueue_case_job(text, uuid, uuid, jsonb, timestamptz, integer, integer, text) to authenticated, service_role;
grant execute on function public.claim_jobs(text, integer, text[]) to service_role;
grant execute on function public.complete_job(uuid, boolean, text, integer) to service_role;
