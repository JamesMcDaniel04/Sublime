import { Plan } from '@prisma/client'
import { entitlementPlanFor, isGrandfatheredOrganization } from './entitlements'

type BillingFields = {
  plan: Plan
  trialEndsAt: Date | null
  createdAt: Date
  grandfatheredAt?: Date | null
}

export type BillingState =
  | { state: 'paid'; plan: Plan }
  | { state: 'payment_required'; plan: Plan }

/**
 * The single billing-access rule. TRIAL remains the legacy enum value for an
 * organization without an active subscription, but it grants no free access:
 * checkout charges from day one and users may cancel at any time.
 */
export function billingStateFor(org: BillingFields): BillingState {
  if (isGrandfatheredOrganization(org)) return { state: 'paid', plan: entitlementPlanFor(org) }
  if (org.plan !== Plan.TRIAL) return { state: 'paid', plan: org.plan }
  return { state: 'payment_required', plan: org.plan }
}

/**
 * Whole days left in a Stripe trial, or null when the org isn't trialing.
 * Rounds up so a trial with 6 hours left reads "1 day", never "0 days" — and
 * clamps at 0 rather than going negative if the webhook is briefly behind
 * Stripe.
 */
export function trialDaysRemaining(
  trialEndsAt: Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!trialEndsAt) return null
  const remainingMs = trialEndsAt.getTime() - now.getTime()
  if (remainingMs <= 0) return 0
  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
}
