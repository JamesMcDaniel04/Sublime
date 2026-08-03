import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { grantTopupCredits } from '@/lib/billing/topups'
import { apiLogger } from '@/lib/logger'
import { applySubscription } from '@/lib/billing/sync-subscription'

export const dynamic = 'force-dynamic'

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
    case 'invoice.payment_failed': {
      const { sendDunningEmails } = await import('@/lib/lifecycle/dunning')
      await sendDunningEmails(event.data.object)
      break
    }
    default:
      break
  }

  return NextResponse.json({ received: true })
}
