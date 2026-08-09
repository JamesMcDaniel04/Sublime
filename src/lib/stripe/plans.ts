import { Plan } from '@/generated/prisma/client'

/**
 * Free days granted on a workspace's first subscription. A pricing decision,
 * not a deployment one — deliberately a constant rather than an env var so it
 * can't drift between environments or be changed without a code review.
 */
export const TRIAL_DAYS = 14

/** Marketing tier → Stripe price env var → internal Plan enum. */
export type PaidPlanKey = 'individual' | 'team' | 'business'

export const PAID_PLANS: Record<PaidPlanKey, { label: string; priceEnv: string; plan: Plan }> = {
  individual: { label: 'Individual', priceEnv: 'STRIPE_PRICE_INDIVIDUAL', plan: Plan.STARTER },
  team: { label: 'Team', priceEnv: 'STRIPE_PRICE_TEAM', plan: Plan.PROFESSIONAL },
  business: { label: 'Business', priceEnv: 'STRIPE_PRICE_BUSINESS', plan: Plan.BUSINESS },
}

export function isPaidPlanKey(value: string | null | undefined): value is PaidPlanKey {
  return value === 'individual' || value === 'team' || value === 'business'
}

export function priceIdFor(key: PaidPlanKey): string {
  const priceId = process.env[PAID_PLANS[key].priceEnv]
  if (!priceId) throw new Error(`${PAID_PLANS[key].priceEnv} is not configured`)
  return priceId
}

/**
 * The trial half of a Checkout session's `subscription_data`, or nothing.
 *
 * One free trial per workspace, ever: a non-null `trialStartedAt` means the
 * workspace already had one, so a repeat checkout (cancelled on day 13 and
 * come back, or switching plans) charges from day one. Returning a spreadable
 * object keeps the caller free of branching.
 *
 * Pairs with `payment_method_collection: 'always'` at the call site, which is
 * what forces a card even through a fully-discounted trial.
 */
type TrialParams = {
  trial_period_days?: number
  trial_settings?: { end_behavior: { missing_payment_method: 'cancel' } }
}

export function trialParamsFor(trialStartedAt: Date | null | undefined): TrialParams {
  if (trialStartedAt) return {}
  return {
    trial_period_days: TRIAL_DAYS,
    // Defense in depth: 'always' should make a card-less trial impossible. If
    // that invariant ever breaks, cancel rather than grant free access.
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
  }
}

/** Reverse lookup used by the webhook: which Plan does a Stripe price grant? */
export function planForPriceId(priceId: string): Plan | null {
  for (const key of Object.keys(PAID_PLANS) as PaidPlanKey[]) {
    if (process.env[PAID_PLANS[key].priceEnv] === priceId) return PAID_PLANS[key].plan
  }
  return null
}
