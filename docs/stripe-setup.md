# Stripe billing setup

The billing code (checkout, portal, webhook, 14-day trial) is fully implemented
— what makes the buttons on `/settings?tab=billing` actually work is this
configuration in the Stripe dashboard and the deployment's environment
variables. Until it's done, checkout attempts now bounce back to the billing
tab with a visible error toast (previously they dead-ended on a bare 500).

## 1. Create the products and prices (Stripe dashboard)

Dashboard → Product catalog → create three products, each with one **recurring
monthly** price:

| Product    | Price        | Maps to plan |
| ---------- | ------------ | ------------ |
| Individual | $29.99/month | STARTER      |
| Team       | $299/month   | PROFESSIONAL |
| Business   | $2,999/month | BUSINESS     |

Copy each price id (`price_…`). Use live-mode prices for production; test-mode
ids for staging/local.

## 2. Create the webhook endpoint (Stripe dashboard)

Dashboard → Developers → Webhooks → Add endpoint:

- **URL**: `https://www.trysublime.io/api/stripe/webhook`
- **Events**: `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`

Copy the signing secret (`whsec_…`). Without this endpoint, payments succeed
in Stripe but the org's plan never upgrades in the app.

## 3. Enable the customer portal (Stripe dashboard)

Dashboard → Settings → Billing → Customer portal → activate it, and allow
**cancel subscription** (this is what makes "cancel anytime before the trial
ends at no charge" self-service) and payment-method updates.

## 4. Set the environment variables (Vercel → Project → Settings → Environment Variables)

```
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

## 5. How the trial interacts with checkout (already in code)

- Every new workspace gets `trialEndsAt = signup + 14 days`.
- Subscribing **during** the trial passes the remaining days as a Stripe
  trial: card on file now, first charge when the 14 days end, cancel before
  then in the portal = $0.
- Subscribing **after** expiry charges immediately.
- The webhook downgrade path returns a canceled org to TRIAL, which re-locks
  once `trialEndsAt` is past.

## 6. Verify end-to-end (test mode first)

1. With test-mode keys, sign up with a fresh account → Settings → Billing →
   pick a plan.
2. Pay with card `4242 4242 4242 4242` (any future expiry/CVC).
3. Confirm: Stripe shows the subscription **trialing** with the trial ending
   on your signup+14 date; the app's billing tab shows the paid plan (webhook
   round-trip works).
4. In the portal ("Manage billing"), cancel — the app should return to Trial.
5. Repeat once with live keys and a real card before launch.

## Troubleshooting

- **Button bounces back with an error toast** → an env var in step 4 is
  missing/wrong; the server log line `stripe checkout failed` has the cause.
- **Paid but app still shows Trial** → webhook not firing: check step 2's URL,
  events, and `STRIPE_WEBHOOK_SECRET`.
- **"active subscription with unrecognized price" in logs** → a price id in
  the dashboard doesn't match `STRIPE_PRICE_*`; the app deliberately keeps the
  customer's plan and alarms instead of downgrading a paying org.
