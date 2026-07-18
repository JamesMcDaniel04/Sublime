import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/auth-utils'
import { prisma } from '@/lib/prisma'
import { getStripe, appOrigin } from '@/lib/stripe'

export const dynamic = 'force-dynamic'

// Redirect into the Stripe customer portal for self-service subscription
// management (payment method, upgrades, cancellation).
export async function GET(request: NextRequest) {
  const origin = appOrigin(request.nextUrl.origin)

  const auth = await requireAuth()
  if (!auth?.organizationId) {
    return NextResponse.redirect(new URL('/auth/login?return_to=%2Fapi%2Fstripe%2Fportal', origin))
  }

  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { stripeCustomerId: true },
  })
  if (!organization?.stripeCustomerId) {
    return NextResponse.redirect(new URL('/settings?tab=billing', origin))
  }

  const session = await getStripe().billingPortal.sessions.create({
    customer: organization.stripeCustomerId,
    return_url: `${origin}/settings?tab=billing`,
  })
  return NextResponse.redirect(session.url, { status: 303 })
}
