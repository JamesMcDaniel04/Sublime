import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/auth-utils'
import { billingStateFor } from '@/lib/billing/trial'

export const dynamic = 'force-dynamic'

// Deliberately NOT wrapped in withAuthenticatedApi: that wrapper rejects
// expired trials with 402, and this endpoint is what the lockout screen reads
// to know it should be showing. It must stay reachable while locked.
export async function GET() {
  const auth = await requireAuth()
  if (!auth?.dbUser?.organization) {
    return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
  }

  const organization = auth.dbUser.organization
  const billing = billingStateFor(organization)

  return NextResponse.json({
    success: true,
    state: billing.state,
    plan: billing.plan,
    trialEndsAt: 'trialEndsAt' in billing ? billing.trialEndsAt.toISOString() : null,
    daysLeft: billing.state === 'trialing' ? billing.daysLeft : 0,
    hasSubscription: Boolean(organization.stripeSubscriptionId),
  })
}
