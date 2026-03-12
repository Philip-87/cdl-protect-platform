alter table public.cases
  add column if not exists violation_date date,
  add column if not exists court_case_number text,
  add column if not exists attorney_update_date date;

create index if not exists idx_cases_violation_date on public.cases (violation_date);
create index if not exists idx_cases_attorney_update_date on public.cases (attorney_update_date);
