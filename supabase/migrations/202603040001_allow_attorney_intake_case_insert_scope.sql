-- Allow attorney-originated intake inserts when case is owned/assigned/scoped to the user.
-- Safe to run multiple times.

alter table if exists public.cases enable row level security;

drop policy if exists "cases_insert_attorney_intake_scope" on public.cases;
create policy "cases_insert_attorney_intake_scope"
on public.cases
for insert
to authenticated
with check (
  public.is_staff(auth.uid())
  or owner_id = auth.uid()
  or driver_id = auth.uid()
  or assigned_attorney_user_id = auth.uid()
  or exists (
    select 1
    from public.attorney_firm_memberships afm
    where afm.user_id = auth.uid()
      and afm.firm_id = cases.attorney_firm_id
  )
  or exists (
    select 1
    from public.agency_memberships am
    where am.user_id = auth.uid()
      and am.agency_id = cases.agency_id
  )
  or exists (
    select 1
    from public.fleet_memberships fm
    where fm.user_id = auth.uid()
      and fm.fleet_id = cases.fleet_id
  )
);
