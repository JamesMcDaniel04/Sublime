# Card-required 14-day trial

**Date:** 2026-07-28
**Status:** approved, ready for planning

## Problem

Sublime is paid from day one. `billingStateFor()` returns `payment_required`
for any workspace on `Plan.TRIAL`, checkout charges the full price
immediately, and the `trialEndsAt` column is dead weight marked "legacy".

We want a 14-day trial that costs a prospect nothing on day 0 but still puts a
card on file **before** they see the product — card collected at signup, first
charge on day 15, cancel before then for $0.

Three defects sit directly on this path and are fixed here:

1. `ACTIVE_STATUSES` at `src/app/api/stripe/webhook/route.ts:16` is
   `{'active', 'past_due'}`. Stripe puts a card-collected trial subscription in
   status **`trialing`**, which is absent from that set — so enabling a trial
   today would have the webhook downgrade the org to `Plan.TRIAL` and lock the
   user out the instant checkout completed.
2. `TrialGate` renders `children` whenever `status` is `null`
   (`src/components/billing/trial-gate.tsx:34`), which is true during the
   initial fetch and on any fetch error. An unpaid user therefore *does* enter
   the platform: the dashboard paints, then the pricing screen replaces it. The
   client gate also fails open by design — the opposite of what we want.
3. `AppShell` gates on a hand-maintained `APP_PREFIXES` array
   (`src/components/layout/app-shell.tsx:22`) that already has a hole:
   `/skills/[id]` is an authenticated product page and is not in the list, so it
   renders with no sidebar and no gate at all.

`docs/stripe-setup.md` still documents a 14-day trial that was removed from the
code. It is stale and is rewritten as part of this work.

## 1. Access model

`billingStateFor()` in `src/lib/billing/trial.ts` is **not modified**. Its rule
is already "an org is paid iff `plan !== TRIAL`", and the webhook is what
decides when `plan !== TRIAL`. The trial is not a new access state; it is the
webhook learning that `trialing` is a paying status.

| Stripe subscription status | Org plan written | Access |
| --- | --- | --- |
| `trialing` | the paid plan | full |
| `active` | the paid plan | full |
| `past_due`, `firstPaidAt` set | the paid plan | grace while Stripe retries |
| `past_due`, `firstPaidAt` null | `TRIAL` | locked — never paid us |
| `canceled` / `unpaid` / `incomplete_expired` | `TRIAL` | locked |
| no subscription at all | `TRIAL` | locked — **this is the card gate** |

Grandfathered workspaces (`isGrandfatheredOrganization`) keep their existing
unconditional `ENTERPRISE` bypass. Nothing in this spec touches them.

The card requirement needs no new primitive: checkout already sets
`payment_method_collection: 'always'`
(`src/app/api/stripe/checkout/route.ts:74`), which is exactly what forces card
entry through a 100%-discounted trial. No subscription reaches `trialing`
without a card on file.

## 2. Schema

Two nullable columns on `Organization`, and `trialEndsAt` is promoted from dead
legacy field to live state rather than adding a third column.

```prisma
/// Stamped by the Stripe webhook the first time a `trialing` subscription is
/// observed for this org. Non-null means the one free trial has been used;
/// checkout then charges immediately. Never reset.
trialStartedAt  DateTime? @db.Timestamptz(6)

/// Stamped on the first `invoice.payment_succeeded` with amount_paid > 0.
/// Distinguishes "card failed on day 15, never paid us" from "paying customer
/// whose card expired" when a subscription goes past_due.
firstPaidAt     DateTime? @db.Timestamptz(6)

/// No longer legacy: mirrors `subscription.trial_end` so the UI can show days
/// remaining. Read-only outside the webhook.
trialEndsAt     DateTime? @db.Timestamptz(6)
```

`trialStartedAt` is stamped by the **webhook**, not at checkout-session
creation, so a prospect who opens checkout and abandons it does not burn their
trial. Checkout only *reads* it to decide eligibility.

### 2.1 The backfill is mandatory

Every workspace paying us today has `firstPaidAt = NULL`. Shipping the dunning
rule in §1 without a backfill means the first existing customer whose card
expires goes `active → past_due → firstPaidAt is null → locked out` — precisely
the failure the current unconditional `past_due` grace was written to prevent.

The migration must, in the same transaction as the column add:

```sql
UPDATE organizations SET first_paid_at = NOW() WHERE plan <> 'TRIAL';
```

`NOW()` rather than `created_at`: the column is only ever tested for null, so
the exact instant is immaterial, and `NOW()` cannot be confused with a real
first-payment timestamp during later debugging.

## 3. Checkout

`src/app/api/stripe/checkout/route.ts` gains a trial branch. `TRIAL_DAYS = 14`
lives in `src/lib/stripe/plans.ts` beside the other billing constants.

```ts
// select() must be widened to include trialStartedAt
subscription_data: {
  metadata: { organizationId: organization.id, planKey: plan },
  ...(organization.trialStartedAt == null && {
    trial_period_days: TRIAL_DAYS,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
  }),
},
```

`payment_method_collection: 'always'` stays as-is and is load-bearing — with a
trial, Stripe would otherwise default to not requiring a card.

`trial_settings.end_behavior.missing_payment_method: 'cancel'` is defense in
depth: `always` should make a missing payment method impossible, and if that
invariant is ever broken we want the subscription cancelled, not silently
granting free access.

An org with `trialStartedAt != null` — cancelled on day 13 and coming back, or
switching plans — gets no trial and is charged immediately. Plan switches for a
*currently* trialing org go through the Stripe portal, which preserves the
original trial end date; we do not create a second checkout session for them.

## 4. Webhook

`src/app/api/stripe/webhook/route.ts`:

- Replace `ACTIVE_STATUSES` with an explicit two-tier check:
  `GRANTS_ACCESS = {'active', 'trialing'}`, plus `past_due` granting access
  only when `organization.firstPaidAt != null`.
- Widen the two `findUnique` selects to include `firstPaidAt` and
  `trialStartedAt`.
- On a `trialing` subscription: stamp `trialStartedAt` if null, and write
  `trialEndsAt` from `subscription.trial_end`.
- On a non-trialing subscription: clear `trialEndsAt`.
- Handle `invoice.payment_succeeded`: when `amount_paid > 0`, stamp
  `firstPaidAt` if null. Resolve the org via the invoice's customer id.
- Extend the existing "active subscription with unrecognized price → alarm,
  do not downgrade" guard (`webhook/route.ts:39-48`) to cover `trialing` as
  well. Without this, a price id that does not match `STRIPE_PRICE_*` silently
  locks out a trialing org instead of alarming.

Idempotency is unchanged: all writes are last-write-wins on org state except
credit top-ups, which remain keyed on `stripeRef`. Stamping is `if null`, so
webhook retries and out-of-order delivery cannot move `trialStartedAt` or
`firstPaidAt` forward a second time.

Stripe dashboard config gains one event: `invoice.payment_succeeded`.
`checkout.session.completed`, `customer.subscription.updated`, and
`customer.subscription.deleted` are already subscribed and still cover both
trial-end transitions (`trialing → active` on success, `trialing → past_due` on
failure).

## 5. The gate

### 5.1 `(app)` route group

The eight authenticated route directories — `dashboard`, `goals`, `agents`,
`integrations`, `connections`, `templates`, `flows`, `settings` — plus
`skills` move under `src/app/(app)/` via `git mv`. A route group changes no
URLs.

`src/app/(app)/layout.tsx` is a server component that owns the gate. Because
the group is the membership list, `APP_PREFIXES` in `app-shell.tsx` is deleted
and `AppShell` no longer decides *whether* to render chrome — the layout
renders it unconditionally. `AppShell` keeps its `FULLSCREEN_ROUTES` /
`usePathname` logic, which decides only whether the content area is
edge-to-edge; that stays client-side and is unaffected.

This closes the `/skills/[id]` hole by construction and makes it impossible for
a future route to forget the gate. Note the visible consequence: `/skills/[id]`
is currently outside `APP_PREFIXES` and renders bare, so after this change it
gains the sidebar. That is the intended fix, not a regression — it is an
authenticated product page that should always have had both the chrome and the
gate.

The root `src/app/layout.tsx` is left alone. Calling `cookies()` there would
force `/about`, `/contact`, `/privacy`, and `/terms` to render dynamically for
no benefit. (`/` is already `force-dynamic`.)

### 5.2 `resolveBillingAccess()`

New server-only helper at `src/lib/billing/access.ts`:

```ts
type BillingAccess =
  | { status: 'allowed'; plan: Plan; trialEndsAt: Date | null }
  | { status: 'payment_required' }
  | { status: 'unavailable' }   // could not resolve; see §6
```

It reuses `getAuthWithUser()` and `billingStateFor()` — no new access rule, no
second source of truth. Unauthenticated callers never reach it; middleware
already redirects them to `/auth/login`.

### 5.3 UI

The plan-picker markup is extracted out of `trial-gate.tsx` into a
server-rendered `<PlanPicker/>` under `src/components/billing/`. The client
`TrialGate` component is **deleted**, not kept as a backstop: two gates that
can disagree is worse than one that cannot.

The 402 in `requireAuthContext` (`src/lib/server/auth.ts:56-63`) stays exactly
as it is. It is the API-layer backstop and the only gate that protects data;
the layout gate protects the *entry*.

`/api/billing/status` gains `trialEndsAt` and a derived `trialDaysRemaining`,
and the app shell shows a single compact "N days left in your trial" line for
orgs with a live `trialEndsAt`. This is the minimum honest disclosure for a
trial that ends in a charge; it is the one piece of net-new UI in this spec.

## 6. Error handling

If `resolveBillingAccess()` cannot resolve billing state (Postgres unreachable,
Supabase error), it returns `unavailable` and the layout renders an error state
with a retry action — **not** the plan picker and **not** the app.

Showing "choose a plan" to a paying customer because the database blinked is a
worse failure than a visible error. Rendering the app anyway is pointless: every
data API behind it will 402 or 500, producing a broken shell instead of an
honest message.

This is a deliberate reversal of the current fail-open comment in
`trial-gate.tsx:14-17`, and it is safe *because* the failure now renders an
error rather than a lockout screen — a paying customer never sees a pricing
wall they cannot explain.

## 7. Tests

Every existing assertion in `src/lib/billing/__tests__/trial.test.ts` stays
green unmodified: "a new unpaid workspace requires payment immediately" is
still true, because a workspace without a card on file is still
`payment_required`. That the access-rule tests survive untouched is the check
that §1's claim — no change to `billingStateFor` — actually holds.

New coverage:

- **Webhook status matrix** — each row of §1's table maps to the expected org
  plan, including both `past_due` branches, and the unrecognized-price guard
  firing for `trialing` as well as `active`.
- **Stamping** — `trialStartedAt` and `firstPaidAt` are set once and never
  moved by a repeat event; `trialEndsAt` is written on `trialing` and cleared
  when the subscription leaves it.
- **Checkout eligibility** — the created session carries
  `trial_period_days: 14` when `trialStartedAt` is null and omits it entirely
  when it is set, with the Stripe client stubbed.
- **Route smoke** (per the `verify` skill's protocol, real handlers against a
  throwaway Postgres) — an org with no subscription is server-rendered the plan
  picker and no dashboard markup; a `trialing` org renders the app.

## 8. Docs

`docs/stripe-setup.md` is rewritten, not patched: §5 currently describes the
old signup-anchored trial (`trialEndsAt = signup + 14 days`) which was never
what shipped and is not what this spec builds. The new §5 describes the
subscription-anchored trial, and §2 adds `invoice.payment_succeeded` to the
required webhook events.

No new environment variables. `STRIPE_PRICE_*`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, and `NEXT_PUBLIC_APP_URL` are unchanged, and the trial
length is a code constant rather than config — it is a pricing decision, not a
deployment one.

## 9. Rollout

1. Migration + backfill (§2.1) deploys first and is inert on its own.
2. Webhook and checkout changes deploy together. Between step 1 and this step,
   behavior is unchanged.
3. Add `invoice.payment_succeeded` in the Stripe dashboard.
4. Route group + gate deploy last; the 402 covers data the whole time.

Verify in Stripe test mode before live: a fresh signup reaches checkout, pays
with `4242 4242 4242 4242`, and lands in the app with the subscription showing
`trialing` and a trial end 14 days out — then cancel in the portal and confirm
the app re-locks.

## Out of scope

- `customer.subscription.trial_will_end` reminder emails (Stripe's own trial
  reminder email covers the legal minimum).
- One-trial-per-email dedupe across workspaces; the rule here is one trial per
  workspace.
- Any separate explicit $1 authorize-and-void. Stripe Checkout in
  `subscription` mode with a trial already validates the card via the
  SetupIntent it creates to save the payment method, which performs the $0 or
  small network authorization. A second PaymentIntent would add a real charge
  on the customer's statement for no additional signal.
- Proration and mid-trial plan changes beyond what the Stripe portal already
  does.

## Risks

- **The backfill (§2.1) is the highest-consequence step in this spec.** If it
  is skipped or fails, existing paying customers lose access on their first
  card decline. The migration must be verified against the QA Postgres before
  production.
- The route-group move touches nine directories and will conflict with any
  other in-flight work on those paths. It should land as its own commit,
  separate from the billing-logic commits.
