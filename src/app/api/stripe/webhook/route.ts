import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { Plan } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { planForPriceId } from '@/lib/stripe/plans'

export const dynamic = 'force-dynamic'

// Statuses that keep the paid plan active. Anything else (canceled, unpaid,
// incomplete_expired) downgrades to TRIAL until Stripe says otherwise.
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due'])

async function applySubscription(subscription: Stripe.Subscription) {
  const organizationId = subscription.metadata?.organizationId
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id

  const organization = organizationId
    ? await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } })
    : await prisma.organization.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } })
  if (!organization) return

  const priceId = subscription.items.data[0]?.price?.id
  const paidPlan = priceId ? planForPriceId(priceId) : null
  const isActive = ACTIVE_STATUSES.has(subscription.status)

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
