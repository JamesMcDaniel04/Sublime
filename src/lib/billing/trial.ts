import { Plan } from '@prisma/client'
import { entitlementPlanFor, isGrandfatheredOrganization } from './entitlements'

type BillingFields = {
  plan: Plan
  trialEndsAt: Date | null
  firstPaidAt: Date | null
  createdAt: Date
  grandfatheredAt?: Date | null
}

export type BillingState =
  | { state: 'paid'; plan: Plan }
  | { state: 'payment_required'; plan: Plan }

/**
 * Webhook lag allowance. A trialEndsAt this far in the past with no collected
 * payment means the trial-cancellation webhook was missed — deny defensively
 * rather than trusting a stale paid `plan`. Wide enough that a legitimate
 * trial→paid conversion (invoice + subscription.updated within minutes) never
 * trips it; the daily reconcile cron closes whatever this window leaves.
 */
export const TRIAL_LAPSE_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * The single billing-access rule. TRIAL remains the legacy enum value for an
 * organization without an active subscription, but it grants no free access:
 * checkout charges from day one and users may cancel at any time.
 *
 * The lapse branch is defensive: `plan` is normally kept honest by the Stripe
 * webhook, but a missed cancellation event would otherwise leave a lapsed
 * trial on a paid plan forever. trialEndsAt is only ever set while trialing
 * (cleared on conversion), so a stale past value plus no collected payment
 * can only mean the downgrade never arrived.
 */
export function billingStateFor(org: BillingFields, now: Date = new Date()): BillingState {
  if (isGrandfatheredOrganization(org)) return { state: 'paid', plan: entitlementPlanFor(org) }
  const trialLapsedUnpaid =
    org.trialEndsAt != null &&
    now.getTime() - org.trialEndsAt.getTime() > TRIAL_LAPSE_GRACE_MS &&
    org.firstPaidAt == null
  if (trialLapsedUnpaid) return { state: 'payment_required', plan: org.plan }
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
