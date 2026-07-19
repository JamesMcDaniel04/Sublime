import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { Plan } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { planForPriceId } from '@/lib/stripe/plans'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

export const dynamic = 'force-dynamic'

// Statuses that keep the paid plan active. Anything else (canceled, unpaid,
// incomplete_expired) downgrades to TRIAL until Stripe says otherwise.
const ACTIVE_STATUSES = new Set(['active', 'past_due'])

async function applySubscription(subscription: Stripe.Subscription) {
  const organizationId = subscription.metadata?.organizationId
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id

  const organization = organizationId
    ? await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } })
    : await prisma.organization.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } })
  if (!organization) return

  // A multi-item subscription carries the base plan on ONE of its items —
  // match any of them, not just items[0].
  const paidPlan = subscription.items.data
    .map((item) => (item.price?.id ? planForPriceId(item.price.id) : null))
    .find((plan) => plan != null) ?? null
  const isActive = ACTIVE_STATUSES.has(subscription.status)

  // An ACTIVE subscription with an unrecognized price is a configuration bug
  // (price edited in the Stripe dashboard, annual/legacy price not in
  // STRIPE_PRICE_*), NOT a cancellation — Stripe is still charging this
  // customer. Downgrading here would silently lock out a paying org, so keep
  // their current plan untouched and alarm loudly instead.
  if (isActive && !paidPlan) {
    const priceIds = subscription.items.data.map((item) => item.price?.id).filter(Boolean)
    apiLogger.error('stripe webhook: active subscription with unrecognized price — plan left unchanged', {
      organizationId: organization.id, subscriptionId: subscription.id, priceIds,
    })
    captureError(new Error('Stripe subscription price not in STRIPE_PRICE_* config'), {
      scope: 'stripe.webhook', organizationId: organization.id,
    })
    return
  }

  await prisma.organization.update({
    where: { id: organization.id },
    data: isActive && paidPlan
      ? { plan: paidPlan, stripeSubscriptionId: subscription.id, stripeCustomerId: customerId }
      : { plan: Plan.TRIAL, stripeSubscriptionId: null },
  })
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
      }
      break
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await applySubscription(event.data.object)
      break
    }
    default:
      break
  }

  return NextResponse.json({ received: true })
}
