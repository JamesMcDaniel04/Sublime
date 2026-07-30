import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/auth-utils'
import { prisma } from '@/lib/prisma'
import { getStripe, appOrigin } from '@/lib/stripe'
import { topupPackCredits } from '@/lib/billing/topups'
import { apiLogger } from '@/lib/logger'
import { canManageBillingByRole } from '@/lib/server/permissions'

export const dynamic = 'force-dynamic'

const MAX_PACKS = 10

// Redirect-based additional-usage purchase ("Additional usage available" on
// every plan): a one-time payment for a block of credits applied to the
// current month, on top of the plan allowance. Mirrors the checkout route's
// shape so it's safe to link from the billing tab.
export async function GET(request: NextRequest) {
  const origin = appOrigin(request.nextUrl.origin)
  const packsParam = Number(request.nextUrl.searchParams.get('packs') ?? '1')
  const packs = Number.isFinite(packsParam) ? Math.min(Math.max(Math.floor(packsParam), 1), MAX_PACKS) : 1

  try {
    return await startTopup(packs, origin)
  } catch (error) {
    apiLogger.error('stripe topup failed', {
      packs,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.redirect(new URL('/settings?tab=billing&billing_error=topup', origin))
  }
}

async function startTopup(packs: number, origin: string) {
  const auth = await requireAuth()
  if (!auth?.dbUser || !auth.organizationId) {
    const returnTo = `/api/stripe/topup?packs=${packs}`
    return NextResponse.redirect(new URL(`/auth/signup?return_to=${encodeURIComponent(returnTo)}`, origin))
  }
  // Buying credits spends the workspace's card — admin-only, same as the rest
  // of billing:manage. The plan exemption above does not cover role.
  if (!canManageBillingByRole(auth.dbUser.role)) {
    return NextResponse.redirect(new URL('/settings?tab=billing&billing_error=forbidden', origin))
  }

  const priceId = process.env.STRIPE_PRICE_TOPUP
  if (!priceId) throw new Error('STRIPE_PRICE_TOPUP is not configured')

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

  const credits = topupPackCredits() * packs
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [{ price: priceId, quantity: packs }],
    client_reference_id: organization.id,
    metadata: { organizationId: organization.id, purpose: 'credit_topup', credits: String(credits) },
    success_url: `${origin}/settings?tab=billing&billing=topup_success`,
    cancel_url: `${origin}/settings?tab=billing`,
  })

  if (!session.url) return NextResponse.redirect(new URL('/settings?tab=billing', origin))
  return NextResponse.redirect(session.url, { status: 303 })
}
