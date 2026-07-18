import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/auth-utils'
import { prisma } from '@/lib/prisma'
import { getStripe, appOrigin } from '@/lib/stripe'
import { isPaidPlanKey, priceIdFor } from '@/lib/stripe/plans'

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

  const auth = await requireAuth()
  if (!auth?.dbUser || !auth.organizationId) {
    const returnTo = `/api/stripe/checkout?plan=${plan}`
    return NextResponse.redirect(new URL(`/auth/signup?return_to=${encodeURIComponent(returnTo)}`, origin))
  }

  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { id: true, name: true, stripeCustomerId: true },
  })
  if (!organization) return NextResponse.redirect(new URL('/dashboard', origin))

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
    client_reference_id: organization.id,
    metadata: { organizationId: organization.id, planKey: plan },
    subscription_data: { metadata: { organizationId: organization.id, planKey: plan } },
    success_url: `${origin}/dashboard?billing=success`,
    cancel_url: `${origin}/#pricing`,
  })

  if (!session.url) return NextResponse.redirect(new URL('/dashboard', origin))
  return NextResponse.redirect(session.url, { status: 303 })
}
