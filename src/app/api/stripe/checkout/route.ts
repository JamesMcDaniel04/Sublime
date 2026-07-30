import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/auth-utils'
import { prisma } from '@/lib/prisma'
import { getStripe, appOrigin } from '@/lib/stripe'
import { isPaidPlanKey, priceIdFor, trialParamsFor, type PaidPlanKey } from '@/lib/stripe/plans'
import { apiLogger } from '@/lib/logger'
import { isGrandfatheredOrganization } from '@/lib/billing/entitlements'
import { canManageBillingByRole } from '@/lib/server/permissions'

export const dynamic = 'force-dynamic'

// Redirect-based checkout entry: safe to link from anywhere (landing pricing
// cards, settings). Signed-out visitors bounce through signup and come back
// here via return_to, so the plan they clicked survives the auth loop.
export async function GET(request: NextRequest) {
  const plan = request.nextUrl.searchParams.get('plan')
  const origin = appOrigin(request.nextUrl.origin)

  if (!isPaidPlanKey(plan)) {
    return NextResponse.redirect(new URL('/#pricing', origin))
  }

  try {
    return await startCheckout(plan, origin)
  } catch (error) {
    // A missing STRIPE_SECRET_KEY / price id (or a Stripe API failure) used to
    // surface as a bare 500 — a dead button. Land the user back on the billing
    // tab with a visible error instead.
    apiLogger.error('stripe checkout failed', {
      plan,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.redirect(new URL('/settings?tab=billing&billing_error=checkout', origin))
  }
}

async function startCheckout(plan: PaidPlanKey, origin: string) {

  const auth = await requireAuth()
  if (!auth?.dbUser || !auth.organizationId) {
    const returnTo = `/api/stripe/checkout?plan=${plan}`
    return NextResponse.redirect(new URL(`/auth/signup?return_to=${encodeURIComponent(returnTo)}`, origin))
  }
  // Skipping withAuthenticatedApi exempts this route from the PLAN gate, not
  // from the role one. dbUser.role is already the effective role — legacy
  // platform users are normalized to ADMIN in getAuthWithUser.
  if (!canManageBillingByRole(auth.dbUser.role)) {
    return NextResponse.redirect(new URL('/settings?tab=billing&billing_error=forbidden', origin))
  }

  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { id: true, name: true, stripeCustomerId: true, plan: true, createdAt: true, grandfatheredAt: true, trialStartedAt: true },
  })
  if (!organization) return NextResponse.redirect(new URL('/dashboard', origin))
  if (isGrandfatheredOrganization(organization)) {
    return NextResponse.redirect(new URL('/settings?tab=billing', origin))
  }

  const stripe = getStripe()

  let customerId = organization.stripeCustomerId
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: auth.dbUser.email ?? undefined,
      name: organization.name,
      metadata: { organizationId: organization.id },
    })
    customerId = customer.id
    await prisma.organization.update({
      where: { id: organization.id },
      data: { stripeCustomerId: customerId },
    })
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceIdFor(plan), quantity: 1 }],
    allow_promotion_codes: true,
    // Load-bearing with a trial: without it Stripe lets the customer through
    // checkout with no card, which is the entire thing we're preventing.
    payment_method_collection: 'always',
    client_reference_id: organization.id,
    metadata: { organizationId: organization.id, planKey: plan },
    subscription_data: {
      metadata: { organizationId: organization.id, planKey: plan },
      // One free trial per workspace, ever. trialStartedAt is stamped by the
      // webhook (not here), so abandoning this checkout costs a prospect
      // nothing — but cancelling on day 13 and coming back charges from day one.
      ...trialParamsFor(organization.trialStartedAt),
    },
    success_url: `${origin}/dashboard?billing=success`,
    cancel_url: `${origin}/#pricing`,
  })

  if (!session.url) return NextResponse.redirect(new URL('/dashboard', origin))
  return NextResponse.redirect(session.url, { status: 303 })
}
