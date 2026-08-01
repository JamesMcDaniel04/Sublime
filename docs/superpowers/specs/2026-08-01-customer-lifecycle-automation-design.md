# Customer Lifecycle Automation — Design

**Date:** 2026-08-01
**Status:** Approved
**Branch lineage:** builds on `feat/goal-recovery-plans` (billing enforcement, cron dispatch, digest infra)

## Goal

Remove the founder from the day-to-day customer lifecycle. Access grants and payment
collection are already fully automated (signup → checkout → Stripe webhook → plan);
this work closes the remaining gaps so the only manual touchpoint is responding to
customer complaints:

1. Automated lifecycle email — welcome, onboarding drip, trial-ending reminders,
   failed-payment (dunning) notices, re-engagement/win-back.
2. In-platform feedback capture — persisted to the database and forwarded to the
   founder's inbox. No external CRM; email is the interface, the table is the record.
3. Email-infrastructure hardening — one shared mailer, a send log with exactly-once
   semantics, unsubscribe compliance.

Out of scope: mobile app work (none exists), external CRM sync, admin dashboard,
Resend delivery/bounce webhooks (v2), copy A/B testing.

## Architecture: state-swept cron engine

Emails are **derived from database state**, not scheduled as jobs. A daily sweep asks
questions like "which trialing orgs have `trialEndsAt` within 3 days and no
`trial-3d` send recorded?" and sends the answer set. Event-triggered emails (welcome,
payment-failed) fire directly from the event using the same send log.

Why this over alternatives:
- **BullMQ delayed jobs** would need Redis in prod, introduce a job-staleness problem
  (drip jobs scheduled at signup must be cancelled when the user activates early),
  and delayed jobs are used nowhere in the codebase today.
- **External tools (Loops/Customer.io)** move send state out of the DB and still
  require in-app webhook logic for dunning/trial; the user declined external SaaS.
- State-sweeping matches existing idioms exactly: the weekly goal digest
  (`src/lib/goals/digest.ts`) already runs this pattern off `/api/cron/dispatch`,
  including an atomic per-user claim. Activation *implicitly cancels* drip steps —
  "day 2 if zero goals" simply stops matching — so there is no cancellation logic.

## Components

### 1. Shared email core — `src/lib/email/`

- **`sendEmail` unification.** `src/app/api/contact/route.ts` currently duplicates
  its own Resend `fetch`; it moves onto the shared helper (currently in
  `src/lib/integrations/email.ts`). The product-facing helper relocates to
  `src/lib/email/send.ts`; the agent-tool client keeps delegating to it.
- **`EmailSend` model (Prisma):**
  - `id`, `organizationId`, `userId?`, `emailKey` (e.g. `welcome`, `drip-day2`,
    `trial-3d`, `dunning`, `winback`), `dedupeKey` (**unique**), `to`, `subject`,
    `status` (`PENDING` → `SENT` | `FAILED`), `error?`, `createdAt`, `sentAt?`.
  - `dedupeKey` encodes the once-ness scope, e.g. `trial-3d:org_<id>`,
    `dunning:inv_<id>`, `drip-day2:user_<id>`.
- **Claim-before-send.** Insert the `PENDING` row first (unique-violation ⇒ already
  handled, skip silently), then send, then mark `SENT`/`FAILED`. A `FAILED` row is
  retryable by a later sweep (bounded retries, e.g. 3 attempts). This is the inverse
  of the current digest bug, where the weekly claim is burned before the send and a
  Resend outage silently skips a user for the week — the digest migrates to this
  mechanism as part of this work.
- **Shared layout** `src/lib/email/layout.ts`: header/footer/CTA-button HTML wrapper
  plus `escapeHtml`, used by all lifecycle emails and retrofitted onto the digest.
  Hand-built HTML strings; no react-email/mjml dependency.
- **Unsubscribe.** `User.marketingEmailsOptOut` (boolean, default false) plus a
  signed-token `GET /api/email/unsubscribe?token=…` route (HMAC over userId with an
  app secret; no login required). The link appears in the footer of **marketing**
  emails: onboarding drip and re-engagement/win-back. **Transactional** emails
  (welcome, trial-ending, dunning) always send. Opt-out also suppresses the goal
  digest.

### 2. Lifecycle sequences — `src/lib/lifecycle/emails.ts`

Invoked from the existing `/api/cron/dispatch` daily window, same guard pattern as
`sendWeeklyGoalDigests`. Recipients for org-level emails are the org's ADMIN users.

| Sequence | Trigger | Rule | dedupeKey |
|---|---|---|---|
| Welcome | Event: `provisionUser` creates a **new** org (not invite-join, not identity-link) | Sent via `afterResponse`; intro + "set your first goal" CTA | `welcome:org` |
| Drip day-2 | Daily sweep | Org age ≥ 2 days, zero goals, marketing opt-in | `drip-day2:user` |
| Drip day-5 | Daily sweep | Org age ≥ 5 days, zero connected integrations, marketing opt-in | `drip-day5:user` |
| Trial-3d | Daily sweep | Subscription trialing, `trialEndsAt` ≤ now+3d | `trial-3d:org` |
| Trial-1d | Daily sweep | Subscription trialing, `trialEndsAt` ≤ now+1d | `trial-1d:org` |
| Dunning | Event: Stripe `invoice.payment_failed` webhook | Email admins with Billing Portal link | `dunning:invoice` |
| Re-engage | Daily sweep | Paying org, no user active for 14 days, marketing opt-in | `winback-inactive:org` (once ever) |
| Win-back | Daily sweep | Org cancelled ≥ 7 days ago (`plan = TRIAL`, `firstPaidAt != null`), marketing opt-in | `winback-cancelled:org` (once ever) |

- **Activity signal for re-engagement:** new `User.lastActiveAt`, touched at the
  auth boundary (`requireAuthContext` / provisioning path) at most once per 24h to
  avoid write amplification.
- **Stripe webhook change:** add `invoice.payment_failed` to the handled events in
  `src/app/api/stripe/webhook/route.ts`. Docs note: enable **Smart Retries** in the
  Stripe dashboard (one-time manual toggle) so card retries are automatic.
- Sweeps are bounded (`mapWithConcurrency`, per-org error isolation) like the
  existing dispatch code, and time-window-guarded so they run once per day.

### 3. Feedback capture

- **`FeedbackSubmission` model:** `id`, `organizationId`, `userId`, `category`
  (`COMPLAINT` | `IDEA` | `QUESTION` | `OTHER`), `message` (bounded length),
  `path` (in-app page the user was on), `createdAt`.
- **`POST /api/feedback`** — authenticated (`withAuthenticatedApi`), rate-limited
  (e.g. 5/min per user). Persists first, then forwards to the founder inbox with
  reply-to set to the submitter and plan/support-tier enrichment (same as the
  contact route). Forward failure does not fail the request — the row is the record;
  a `FAILED` `EmailSend` row makes the miss visible and retryable.
- **UI:** a "Feedback" item in the app chrome (user menu, next to existing
  settings/help entries) opening a dialog: category picker + textarea + submit.
  Prefills `path` from the current route.
- **Inbox address** is env-driven: `CONTACT_INBOX`, defaulting to the current
  hard-coded `hello@trysublime.io`. (Flag: the operator's account email is
  `hello@estimoto.io` — different domain; the env var lets them point it anywhere.)
- No admin/triage UI in v1 — email is the interface; the table is the safety net
  and a future import source.

## Data flow summary

```
signup ──▶ provisionUser (new org) ──▶ welcome email (afterResponse, claim-logged)
cron/dispatch (daily window) ──▶ lifecycle sweep ──▶ due-set from DB state ──▶ claim ▶ send ▶ mark
stripe webhook (invoice.payment_failed) ──▶ dunning email (claim per invoice)
feedback dialog ──▶ POST /api/feedback ──▶ DB row ──▶ forward to CONTACT_INBOX
unsubscribe link ──▶ /api/email/unsubscribe?token ──▶ marketingEmailsOptOut = true
```

## Error handling

- `RESEND_API_KEY` unset: lifecycle sweep no-ops with a single warn (matches
  existing `emailConfigured()` behavior); feedback still persists to DB.
- Send failure: `EmailSend` row marked `FAILED` with the error; retried by later
  sweeps up to a bounded attempt count; Sentry warn on final failure.
- Webhook replay / concurrent cron runs: unique `dedupeKey` makes duplicates a
  silent no-op.
- Unsubscribe token invalid/expired: friendly static error page, no information
  leak.

## Testing

Following the existing route-smoke + unit idioms (`src/app/api/__tests__/*-e2e.test.ts`,
`src/lib/billing/__tests__/`):
- Unit: due-set derivation per sequence (fixed `now` injection, mirroring
  `billingStateFor` tests); dedupe/claim semantics incl. unique-violation path;
  unsubscribe token sign/verify.
- Route e2e: `POST /api/feedback` (auth, rate limit, persistence, forward-failure
  tolerance); `invoice.payment_failed` webhook → dunning claim; unsubscribe route.
- Digest regression: claim-then-send ordering now retry-safe.

## Manual setup (one-time, documented in `docs/stripe-setup.md` + env docs)

- Add `invoice.payment_failed` to the Stripe webhook endpoint's event list.
- Enable Smart Retries in Stripe dashboard.
- Verify `RESEND_API_KEY`, `EMAIL_FROM` (real domain, not `onboarding@resend.dev`),
  and new `CONTACT_INBOX` in prod env.
