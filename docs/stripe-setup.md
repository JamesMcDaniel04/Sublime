# Stripe billing setup

The billing code (checkout, portal, webhook, 14-day trial) is fully
implemented — what makes the buttons on `/settings?tab=billing` actually work
is this configuration in the Stripe dashboard and the deployment's environment
variables. Until it's done, checkout attempts bounce back to the billing tab
with a visible error toast rather than dead-ending on a 500.

## 1. Create the products and prices (Stripe dashboard)

Dashboard → Product catalog → create three products, each with one **recurring
monthly** price:

| Product    | Price        | Maps to plan |
| ---------- | ------------ | ------------ |
| Individual | $29.99/month | STARTER      |
| Team       | $299/month   | PROFESSIONAL |
| Business   | $1,999/month | BUSINESS     |

Copy each price id (`price_…`). Use live-mode prices for production; test-mode
ids for staging/local.

Do **not** configure a trial on the price itself. The trial is passed per
checkout session (`TRIAL_DAYS` in `src/lib/stripe/plans.ts`) because it is
granted conditionally — see §5.

## 2. Create the webhook endpoint (Stripe dashboard)

Dashboard → Developers → Webhooks → Add endpoint:

- **URL**: `https://www.trysublime.io/api/stripe/webhook`
- **Events**:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`

Copy the signing secret (`whsec_…`). Without this endpoint, payments succeed
in Stripe but the org's plan never upgrades in the app.

`invoice.payment_succeeded` is not optional. It is the only signal that stamps
`firstPaidAt`, which is what separates a real customer from a trial that never
paid when a subscription later goes `past_due` (§5).

## 3. Enable the customer portal (Stripe dashboard)

Dashboard → Settings → Billing → Customer portal → activate it, and allow
**cancel subscription** (this is what makes "cancel before the trial ends at no
charge" self-service) and payment-method updates.

## 4. Set the environment variables (Vercel → Project → Settings → Environment Variables)

```bash
STRIPE_SECRET_KEY=sk_live_…
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_…
STRIPE_PRICE_INDIVIDUAL=price_…   # from step 1
STRIPE_PRICE_TEAM=price_…
STRIPE_PRICE_BUSINESS=price_…
STRIPE_WEBHOOK_SECRET=whsec_…     # from step 2
NEXT_PUBLIC_APP_URL=https://www.trysublime.io
```

`NEXT_PUBLIC_APP_URL` must be the exact production host (www) — it builds the
checkout success/cancel and portal return URLs. Redeploy after setting.

The trial length is **not** an env var. It's a pricing decision, so it lives in
code where it can't drift between environments.

## 5. How the trial works (already in code)

A workspace cannot enter the product without a card. `src/app/(app)/layout.tsx`
resolves billing state on the server before rendering any app route, so an org
with no subscription is served the plan picker instead of app markup, and
`requireAuthContext` returns 402 from every data API behind it.

- **Checkout** passes `trial_period_days: 14` **only if** the workspace's
  `trialStartedAt` is null, alongside `payment_method_collection: 'always'`.
  That last option is load-bearing: without it Stripe lets a customer through a
  100%-discounted trial with no card at all.
- **During the trial** the subscription sits in Stripe status `trialing`, which
  the webhook treats as a paying status and grants the full plan. The app shows
  a countdown banner.
- **Day 15** Stripe charges the card automatically. On success,
  `invoice.payment_succeeded` stamps `firstPaidAt` and the subscription becomes
  `active`.
- **Cancel before day 14** in the portal → `$0` charged, subscription cancels,
  the org drops to `TRIAL` and re-locks.
- **One trial per workspace, ever.** `trialStartedAt` is stamped by the webhook
  the first time a `trialing` subscription is seen and is never reset, so
  cancelling on day 13 and re-subscribing charges from day one. It is stamped
  from the webhook rather than at checkout creation, so abandoning the Stripe
  checkout page doesn't burn the trial.
- **Failed day-15 charge** → subscription goes `past_due` with `firstPaidAt`
  still null → access is revoked immediately. A long-standing customer whose
  card later expires also goes `past_due`, but has `firstPaidAt` set, so they
  keep access while Stripe's dunning retries.

There is no separate card-authorization step. Stripe Checkout in `subscription`
mode with a trial validates the card via the SetupIntent it creates to save the
payment method, which performs the $0 (or small) network authorization.

### Database prerequisite

The `firstPaidAt` rule above depends on migration
`20260728120000_card_required_trial`, which adds the column **and backfills it
for every existing paying org**. If that backfill is skipped, existing
customers read as "never paid us" and the first card decline locks them out.
Verify after deploying:

```sql
SELECT count(*) FROM organizations WHERE plan::text <> 'TRIAL' AND "firstPaidAt" IS NULL;
-- expect 0
```

## 6. Verify end-to-end (test mode first)

1. With test-mode keys, sign up with a fresh account. You should land on the
   plan picker, not the dashboard.
2. Pick a plan and pay with card `4242 4242 4242 4242` (any future expiry/CVC).
3. Confirm: Stripe shows the subscription **trialing** with the trial ending 14
   days out; the app lets you in and shows the countdown banner (webhook
   round-trip works).
4. In the portal ("Manage billing"), cancel — the app should return to the plan
   picker.
5. Start checkout again: the new session should have **no** trial (the
   workspace already used its one), so the card is charged immediately.
6. Repeat step 1–3 once with live keys and a real card before launch.

To exercise the day-15 conversion without waiting, edit the subscription's
trial end date in the Stripe dashboard to "now".

## Troubleshooting

- **Button bounces back with an error toast** → an env var in step 4 is
  missing/wrong; the server log line `stripe checkout failed` has the cause.
- **Paid but app still shows the plan picker** → webhook not firing: check step
  2's URL, events, and `STRIPE_WEBHOOK_SECRET`.
- **"active subscription with unrecognized price" in logs** → a price id in
  the dashboard doesn't match `STRIPE_PRICE_*`; the app deliberately keeps the
  customer's plan and alarms instead of downgrading a paying org. This guard
  covers trialing subscriptions too.
- **An existing customer got locked out after a card decline** → check the
  backfill in §5. `firstPaidAt IS NULL` on a paying org is the cause.
- **A workspace got a second free trial** → `trialStartedAt` was cleared or the
  webhook never saw the first `trialing` subscription. Check that
  `customer.subscription.updated` is subscribed in step 2.
