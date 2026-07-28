import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { Plan } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { planForPriceId } from '@/lib/stripe/plans'
import { grantTopupCredits } from '@/lib/billing/topups'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { isGrandfatheredOrganization } from '@/lib/billing/entitlements'
import { subscriptionGrantsAccess } from '@/lib/billing/subscription-status'

export const dynamic = 'force-dynamic'

const ORG_BILLING_FIELDS = {
  id: true, plan: true, createdAt: true, grandfatheredAt: true,
  firstPaidAt: true, trialStartedAt: true,
} as const

async function applySubscription(subscription: Stripe.Subscription) {
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

// First real money collected from this workspace. Stamped once — the `firstPaidAt: null`
// in the WHERE makes it idempotent and race-free without a read-then-write, so
// webhook retries and out-of-order delivery can't move it forward.
async function applyInvoicePaid(invoice: Stripe.Invoice) {
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
  if (!customerId) return
  await prisma.organization.updateMany({
    where: { stripeCustomerId: customerId, firstPaidAt: null },
    data: { firstPaidAt: new Date() },
  })
}

// Additional-usage purchase: grant the credits recorded on the checkout
// session. Idempotent on the session id, so webhook retries can't double-grant.
async function applyCreditTopup(session: Stripe.Checkout.Session) {
  const organizationId = session.metadata?.organizationId || session.client_reference_id
  const credits = Number(session.metadata?.credits)
  if (!organizationId || !Number.isFinite(credits) || credits <= 0) {
    apiLogger.error('stripe webhook: credit topup session missing org or credits', {
      sessionId: session.id, organizationId, credits: session.metadata?.credits,
    })
    return
  }
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } })
  if (!organization) return
  await grantTopupCredits({ organizationId, credits, stripeRef: session.id })
}

export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })

  const signature = request.headers.get('stripe-signature')
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const stripe = getStripe()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(await request.text(), signature, secret)
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      if (session.mode === 'subscription' && typeof session.subscription === 'string') {
        const subscription = await stripe.subscriptions.retrieve(session.subscription)
        await applySubscription(subscription)
      } else if (session.mode === 'payment' && session.metadata?.purpose === 'credit_topup') {
        await applyCreditTopup(session)
      }
      break
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await applySubscription(event.data.object)
      break
    }
    // Fires when the trial converts on day 15 (and on every renewal after).
    // This is the only signal that separates a real customer from a trial that
    // never paid, which the past_due rule depends on.
    case 'invoice.payment_succeeded': {
      await applyInvoicePaid(event.data.object)
      break
    }
    default:
      break
  }

  return NextResponse.json({ received: true })
}
