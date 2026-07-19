import { Plan } from '@prisma/client'

type BillingFields = {
  plan: Plan
  trialEndsAt: Date | null
  createdAt: Date
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
  if (org.plan !== Plan.TRIAL) return { state: 'paid', plan: org.plan }
  return { state: 'payment_required', plan: org.plan }
}
