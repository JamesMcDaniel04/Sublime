import { Plan } from '@prisma/client'

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

/** Reverse lookup used by the webhook: which Plan does a Stripe price grant? */
export function planForPriceId(priceId: string): Plan | null {
  for (const key of Object.keys(PAID_PLANS) as PaidPlanKey[]) {
    if (process.env[PAID_PLANS[key].priceEnv] === priceId) return PAID_PLANS[key].plan
  }
  return null
}
