import type Stripe from 'stripe'
import { Plan } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { planForPriceId } from '@/lib/stripe/plans'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { isGrandfatheredOrganization } from '@/lib/billing/entitlements'
import { subscriptionGrantsAccess } from '@/lib/billing/subscription-status'

/**
 * Collapse a Stripe subscription into organization.plan — the single write
 * path for billing state. Shared by the webhook (primary, event-driven) and
 * the daily reconcile cron (self-healing when an event was missed).
 */

const ORG_BILLING_FIELDS = {
  id: true, plan: true, createdAt: true, grandfatheredAt: true,
  firstPaidAt: true, trialStartedAt: true,
} as const

export async function applySubscription(subscription: Stripe.Subscription) {
  const organizationId = subscription.metadata?.organizationId
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id

  const organization = organizationId
    ? await prisma.organization.findUnique({ where: { id: organizationId }, select: ORG_BILLING_FIELDS })
    : await prisma.organization.findUnique({ where: { stripeCustomerId: customerId }, select: ORG_BILLING_FIELDS })
  if (!organization) return

  // A multi-item subscription carries the base plan on ONE of its items —
  // match any of them, not just items[0].
  const paidPlan = subscription.items.data
    .map((item) => (item.price?.id ? planForPriceId(item.price.id) : null))
    .find((plan) => plan != null) ?? null
  const grantsAccess = subscriptionGrantsAccess(subscription.status, organization.firstPaidAt)

  // A subscription that grants access but carries an unrecognized price is a
  // configuration bug (price edited in the Stripe dashboard, annual/legacy
  // price not in STRIPE_PRICE_*), NOT a cancellation — Stripe is still
  // charging (or about to charge) this customer. Downgrading here would
  // silently lock out a paying org, so keep their current plan untouched and
  // alarm loudly instead. This covers `trialing` too: a mis-set price on a
  // trial would otherwise lock out the user the moment they hand over a card.
  if (grantsAccess && !paidPlan) {
    const priceIds = subscription.items.data.map((item) => item.price?.id).filter(Boolean)
    apiLogger.error('stripe webhook: active subscription with unrecognized price — plan left unchanged', {
      organizationId: organization.id, subscriptionId: subscription.id, status: subscription.status, priceIds,
    })
    captureError(new Error('Stripe subscription price not in STRIPE_PRICE_* config'), {
      scope: 'stripe.webhook', organizationId: organization.id,
    })
    return
  }

  // Trial bookkeeping. trialEndsAt mirrors Stripe while trialing and is cleared
  // otherwise (display only). trialStartedAt is stamped once and never moved:
  // it is what makes the free 14 days a one-time grant rather than something a
  // workspace can farm by cancelling on day 13 and re-subscribing.
  const trialing = subscription.status === 'trialing'
  const trialEndsAt = trialing && subscription.trial_end ? new Date(subscription.trial_end * 1000) : null
  const stampTrialStart = trialing && !organization.trialStartedAt ? { trialStartedAt: new Date() } : {}

  await prisma.organization.update({
    where: { id: organization.id },
    data: {
      ...(isGrandfatheredOrganization(organization)
        ? { plan: Plan.ENTERPRISE, stripeSubscriptionId: grantsAccess ? subscription.id : null, stripeCustomerId: customerId }
        : grantsAccess && paidPlan
        ? { plan: paidPlan, stripeSubscriptionId: subscription.id, stripeCustomerId: customerId }
        : { plan: Plan.TRIAL, stripeSubscriptionId: null }),
      trialEndsAt,
      ...stampTrialStart,
    },
  })
}

/** True for Stripe's "no such subscription" error shape (deleted/detached). */
function isMissingSubscriptionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string }).code === 'resource_missing'
}

/**
 * Re-sync one organization's plan from Stripe. A vanished subscription is
 * applied as a cancellation (plan reverts to TRIAL; grandfathered orgs keep
 * ENTERPRISE) so a missed `customer.subscription.deleted` webhook self-heals.
 */
export async function reconcileOrganizationSubscription(
  stripe: Stripe,
  org: { id: string; stripeSubscriptionId: string },
): Promise<{ outcome: 'synced' | 'cleared' }> {
  try {
    const subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId)
    await applySubscription(subscription)
    return { outcome: 'synced' }
  } catch (error) {
    if (!isMissingSubscriptionError(error)) throw error
    const organization = await prisma.organization.findUnique({
      where: { id: org.id },
      select: ORG_BILLING_FIELDS,
    })
    if (!organization) return { outcome: 'cleared' }
    await prisma.organization.update({
      where: { id: organization.id },
      data: {
        ...(isGrandfatheredOrganization(organization)
          ? { plan: Plan.ENTERPRISE, stripeSubscriptionId: null }
          : { plan: Plan.TRIAL, stripeSubscriptionId: null }),
        trialEndsAt: null,
      },
    })
    return { outcome: 'cleared' }
  }
}
