# Trial-lapse enforcement hardening

**Date:** 2026-07-31
**Status:** Approved
**Prior art:** [2026-07-28-card-required-trial-design.md](2026-07-28-card-required-trial-design.md) — the card-required trial + paywall this design hardens.

## Problem

Access revocation after a lapsed trial currently depends 100% on Stripe webhook
delivery. `billingStateFor()` never reads `trialEndsAt`; a missed
`customer.subscription.updated/deleted` webhook leaves a lapsed org on a paid
`plan` forever, with no reconciliation. Separately, background execution
(scheduled agents, flows, token-authenticated trigger routes, Slack) is not
billing-gated at all — an unpaid org's automations keep running even while its
humans see the paywall. Finally, the paywall offers a "14-day trial" to orgs
that already consumed theirs, but Stripe would charge them immediately.

Decisions made with the user:

- Grandfathering (orgs created before `GRANDFATHERED_WORKSPACE_CUTOFF`) stays
  as-is: permanently comped, out of scope.
- Both a defensive time-based check and a daily Stripe reconcile: yes.
- Background execution hard-stops for unpaid orgs: yes.
- Deploy question flagged separately: `main` has none of the billing
  enforcement (500 commits behind this branch); production must ship this
  lineage for any of it to matter.

## Design

### 1. Defensive lapse rule in `billingStateFor` (src/lib/billing/trial.ts)

Add `firstPaidAt: Date | null` to `BillingFields`. New branch, evaluated after
the grandfather check and before the `plan !== TRIAL` allow:

> If `trialEndsAt` is more than `TRIAL_LAPSE_GRACE_HOURS` (24) in the past and
> `firstPaidAt` is null → `payment_required`, regardless of `plan`.

Rationale: the webhook sets `trialEndsAt` only while `trialing` and clears it
on conversion. A stale past `trialEndsAt` plus no collected payment means the
lapse webhook was missed. The 24h grace absorbs webhook/invoice lag during a
legitimate trial→paid conversion; the reconcile job (below) closes the
remaining window. `billingStateFor` gains an optional `now: Date = new Date()`
parameter for testability, matching `trialDaysRemaining`.

The paywall (`resolveBillingAccess`) and the API 402 (`requireAuthContext`)
inherit this automatically — both defer to `billingStateFor`, which remains
the single access rule.

### 2. Daily Stripe reconcile (self-healing for missed webhooks)

- Extract the webhook's `applySubscription` (and `ORG_BILLING_FIELDS`) into
  `src/lib/billing/sync-subscription.ts`, logic unchanged; the webhook route
  imports it. This also closes the existing "no webhook-logic tests" gap.
- New route `src/app/api/cron/billing-reconcile/route.ts`, CRON_SECRET
  bearer auth copied verbatim from `cron/dispatch` (fail closed, constant-time
  compare). Daily `vercel.json` cron entry.
- For every org with `stripeSubscriptionId != null`:
  `stripe.subscriptions.retrieve` → `applySubscription`. Per-org failures are
  isolated (log + continue), a vanished subscription (Stripe 404) applies as
  canceled → plan reverts to TRIAL.
- Alarm path: an org with a paid plan, no `stripeSubscriptionId`, not
  grandfathered → Sentry `captureError` (state that should not exist).
- Bounded: `take: 500`, sequential retrieves (well under Stripe rate limits at
  current scale). Logs a summary count.

### 3. Background execution hard-stop

New helper `assertOrganizationBillingActive(organizationId)` in
`src/lib/billing/enforce.ts` (beside the existing `assert*Capacity` gates):
loads the org's billing fields, throws `ApiError(402, 'PAYMENT_REQUIRED')`
when `billingStateFor(...).state === 'payment_required'`.

Call sites:

- **Choke point:** top of `runAgentExecution` and `dispatchFlowExecution` —
  covers cron dispatch, BullMQ workers, Slack, timed-wait resumes, and any
  future caller in one place.
- **Trigger routes** (`agents/[id]/trigger`, `flows/[id]/trigger`): call it
  before dispatch so external callers get a clean 402 instead of a silently
  failed run.
- **Cron dispatch pre-filter:** batch-resolve billing state for due
  agents'/flows' orgs and skip unpaid ones (debug log) so the tick doesn't
  create doomed execution rows every 15 minutes. The choke point remains the
  backstop.

Interactive API routes already 402 via `requireAuthContext`; unchanged.

### 4. Lapsed-trial paywall copy

Thread `trialUsed: boolean` (`trialStartedAt != null`) through the
`payment_required` variant of `BillingAccess` into `PlanPicker` and
`PricingGrid`. When `trialUsed`: headline drops "Start your 14-day trial",
CTAs read "Subscribe", and the "You won't be charged for 14 days" reassurance
is replaced with copy that billing starts immediately. Checkout behavior is
already correct (`trialParamsFor` returns `{}`); this is copy-truthfulness
only.

### 5. Error handling summary

- `billingStateFor` stays pure and total — no new failure modes.
- Reconcile: per-org isolation; route-level try/catch returns 500 on
  unhandled errors; missing CRON_SECRET → 503.
- `assertOrganizationBillingActive`: org not found → treat as
  payment_required (fail closed).
- Paywall resolution keeps its existing fail-to-error (never fail-open)
  behavior.

## Testing

- **Unit matrix** (`src/lib/billing/__tests__/trial.test.ts`): lapsed
  trial + unpaid → denied; lapsed + `firstPaidAt` set → allowed; within
  24h grace → allowed; null `trialEndsAt` paid plan → allowed; grandfathered
  lapsed → allowed; plan TRIAL → denied (existing).
- **sync-subscription unit tests**: status matrix (trialing/active/past_due
  ±firstPaidAt/canceled), unrecognized-price guard, grandfather branch,
  trial bookkeeping stamps — mocked prisma, no Stripe network.
- **Structural**: `route-permissions.test.ts` gains the new cron route in its
  exempt list (CRON_SECRET-authenticated, like dispatch).
- **rbac-e2e**: trigger route returns 402 for an unpaid org; succeeds for a
  paid one.
- **SSR**: `plan-picker.test.tsx` asserts the `trialUsed` variant renders
  "Subscribe" copy and no 14-day promise.

## Out of scope

- Grandfathering changes (kept as-is by decision).
- `invoice.payment_failed` handling / dunning emails.
- Merging to `main` / production deploy wiring (flagged to user separately).
