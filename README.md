# CDL Protect Platform

CDL Protect is a Next.js + Supabase application for traffic-ticket intake, attorney matching, billing, OCR, and calendar-aware case operations.

## Stack

- Next.js 16
- React 19
- Supabase Auth, Postgres, Storage, and RLS
- Nanonets OCR
- Stripe webhook settlement for payment requests
- LawPay direct checkout for quote collection

## Local Setup

1. Install dependencies.

```bash
npm install
```

2. Copy `.env.example` to `.env.local` and fill in the required values.

3. Apply database migrations.

```bash
npx supabase db push
```

If you are applying migrations manually, run every file in `supabase/migrations` in filename order. The current migration set is:

1. `202602240001_traffic_ticket_platform.sql`
2. `202602250001_fix_case_status_and_policies.sql`
3. `202602250002_case_events.sql`
4. `202602260001_role_based_case_platform.sql`
5. `202602270001_role_hotfix_and_invite_claim.sql`
6. `202602280001_fix_fleet_memberships_rls_recursion.sql`
7. `202602290001_attorney_onboarding_profiles.sql`
8. `202603010001_fix_claim_my_invites_profile_upsert.sql`
9. `202603020001_county_reference_and_firm_profile_extensions.sql`
10. `202603030001_fix_auth_profile_trigger_without_on_conflict.sql`
11. `202603040001_allow_attorney_intake_case_insert_scope.sql`
12. `202603040002_signup_role_selection_driver_fleet.sql`
13. `202603050001_admin_platform_logs.sql`
14. `202603050002_drivers_table_and_attorney_invite_scope.sql`
15. `202603060001_case_status_transition_enforcement.sql`
16. `202603070001_job_queue_and_ocr_async.sql`
17. `202603080001_stripe_payments_and_ledger.sql`
18. `202603090001_attorney_matching_outreach_lawpay.sql`
19. `202603100001_profiles_insert_and_fleet_archiving.sql`
20. `202603100002_scope_policy_insert_repairs.sql`
21. `202603100003_signup_role_and_driver_bootstrap.sql`
22. `202603100004_zz_add_fleet_is_active.sql`
23. `202603100005_zzz_case_tracking_fields.sql`
24. `202603100006_zzzz_admin_custom_roles_and_database_tools.sql`
25. `202603100007_driver_email_case_scope.sql`
26. `202603100008_attorney_calendar_events.sql`
27. `202603100009_calendar_sync_notifications_and_jobs.sql`
28. `202603100010_role_feature_overrides.sql`

4. Start the app.

```bash
npm run dev
```

5. Start the worker if async OCR or calendar jobs are enabled.

```bash
npm run worker:run
```

## Required Configuration

Use `.env.example` as the source of truth. The important groups are:

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Dedicated secrets: `OCR_PREVIEW_TOKEN_SECRET`, `CALENDAR_SYNC_SECRET`, `CRON_SECRET`
- OCR: `NANONETS_API_KEY`, `NANONETS_MODEL_ID`
- Payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LAW_PAY_SECRET_KEY`, `LAW_PAY_ACCOUNT_ID`, `LAW_PAY_ClientCredit_OP`, `LAW_PAY_eCheck_OP`
- Email: `RESEND_API_KEY`, `EMAIL_FROM`
- Calendar integrations: Google and Microsoft OAuth client credentials plus redirect URIs
- App URLs: `NEXT_PUBLIC_SITE_URL` or `NEXT_PUBLIC_APP_URL`

## Verification

Run all release gates before deploying:

```bash
npm run env:check
npm run lint
npm run test
npm run typecheck
npm run build
```

## Production Notes

- Stripe webhooks must point to `/api/payments/stripe/webhook`.
- The background worker endpoint is `/api/cron/worker` and requires `x-cron-secret` or a bearer token matching `CRON_SECRET`.
- User-facing reads and writes are expected to stay on session-scoped Supabase clients. Service role usage is reserved for admin actions, webhooks, and worker execution.
- OCR preview and calendar crypto now require dedicated secrets and do not reuse the cron secret or service-role key.
- A GitHub Actions pipeline is included in `.github/workflows/ci.yml` to run lint, tests, typecheck, and the production build.

## More Docs

- `docs/SUPABASE_SETUP.md`
- `docs/PHASE_STATUS.md`
