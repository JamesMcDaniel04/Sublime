import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/auth-utils'
import { prisma } from '@/lib/prisma'
import { getStripe, appOrigin } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { canManageBillingByRole } from '@/lib/server/permissions'

export const dynamic = 'force-dynamic'

// Redirect into the Stripe customer portal for self-service subscription
// management (payment method, upgrades, cancellation).
export async function GET(request: NextRequest) {
  const origin = appOrigin(request.nextUrl.origin)

  const auth = await requireAuth()
  if (!auth?.organizationId) {
    return NextResponse.redirect(new URL('/auth/login?return_to=%2Fapi%2Fstripe%2Fportal', origin))
  }
  // The portal allows cancellation and payment-method changes, so it is the
  // sharpest edge of billing:manage. Skipping the authenticated-API wrapper
  // exempts this route from the PLAN gate only — the role still has to hold.
  if (!auth.dbUser || !canManageBillingByRole(auth.dbUser.role)) {
    return NextResponse.redirect(new URL('/settings?tab=billing&billing_error=forbidden', origin))
  }

  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { stripeCustomerId: true },
  })
  if (!organization?.stripeCustomerId) {
    return NextResponse.redirect(new URL('/settings?tab=billing', origin))
  }

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: organization.stripeCustomerId,
      return_url: `${origin}/settings?tab=billing`,
    })
    return NextResponse.redirect(session.url, { status: 303 })
  } catch (error) {
    apiLogger.error('stripe portal failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.redirect(new URL('/settings?tab=billing&billing_error=portal', origin))
  }
}
