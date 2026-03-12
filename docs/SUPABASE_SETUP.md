# Supabase Setup Checklist

Use this checklist when auth, storage, payments, or OCR flows are not working in a local or staging environment.

## 1. Environment Variables

Start from `.env.example`. The minimum local set is:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SITE_URL`
- `CRON_SECRET`
- `OCR_PREVIEW_TOKEN_SECRET`
- `CALENDAR_SYNC_SECRET`
- `NANONETS_API_KEY`
- `NANONETS_MODEL_ID`

Add payment, email, maps, and calendar credentials if you need those features locally.

After any `.env.local` change, restart the dev server.

You can audit local coverage against the checked-in template with:

```powershell
npm run env:check
```

## 2. Apply Every Migration

Preferred:

```powershell
npx supabase db push
```

If you use SQL Editor instead, apply every file in `supabase/migrations` in filename order. The repo currently has 28 ordered migrations ending at `202603100010_role_feature_overrides.sql`.

## 3. Auth URL Configuration

In Supabase Dashboard -> Authentication -> URL Configuration:

- Site URL: `http://localhost:3000`
- Redirect URLs:
  - `http://localhost:3000/**`
  - `http://localhost:3001/**`

## 4. Storage Buckets

Verify the required bucket exists:

```sql
select id, public
from storage.buckets
where id = 'case-documents';
```

Expected: one row for `case-documents`.

## 5. Core Tables

Verify the current platform tables exist:

```sql
select
  to_regclass('public.profiles') as profiles,
  to_regclass('public.cases') as cases,
  to_regclass('public.documents') as documents,
  to_regclass('public.case_events') as case_events,
  to_regclass('public.payment_requests') as payment_requests,
  to_regclass('public.payments') as payments,
  to_regclass('public.payment_events') as payment_events,
  to_regclass('public.case_quotes') as case_quotes,
  to_regclass('public.job_queue') as job_queue,
  to_regclass('public.attorney_calendar_integrations') as attorney_calendar_integrations;
```

Every value should be non-null.

## 6. Worker and Webhook Wiring

- Stripe webhook target: `/api/payments/stripe/webhook`
- Worker trigger: `/api/cron/worker`
- Worker auth: `x-cron-secret: <CRON_SECRET>`

You can run the worker locally with:

```powershell
npm run worker:run
```

## 7. Common Failure Modes

- Missing latest migrations, especially the March 2026 payment, queue, calendar, and role-feature migrations
- Using only public Supabase keys without `SUPABASE_SERVICE_ROLE_KEY` for admin, cron, or webhook flows
- Missing dedicated `OCR_PREVIEW_TOKEN_SECRET` or `CALENDAR_SYNC_SECRET`
- Stripe webhook secret not matching the environment that created the checkout session
- `CRON_SECRET` not set while async OCR is enabled
- `NEXT_PUBLIC_SITE_URL` or `NEXT_PUBLIC_APP_URL` not set, which breaks generated callback and checkout URLs
