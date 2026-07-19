import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/auth-utils'
import { billingStateFor } from '@/lib/billing/trial'
import { limitsForPlan, tokensToCredits, formatLimit } from '@/lib/billing/limits'
import { orgUsageSummary } from '@/lib/billing/enforce'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'

export const dynamic = 'force-dynamic'

// Deliberately NOT wrapped in withAuthenticatedApi: that wrapper rejects
// unpaid workspaces with 402, and this endpoint is what the lockout screen reads
// to know it should be showing. It must stay reachable while locked.
export async function GET() {
  const auth = await requireAuth()
  if (!auth?.dbUser?.organization) {
    return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
  }

  const organization = auth.dbUser.organization
  const billing = billingStateFor(organization)
  const limits = limitsForPlan(organization.plan)
  const [usage, budget] = await Promise.all([
    orgUsageSummary(organization.id),
    checkMonthlyTokenBudget(organization.id),
  ])

  return NextResponse.json({
    success: true,
    state: billing.state,
    plan: billing.plan,
    hasSubscription: Boolean(organization.stripeSubscriptionId),
    limits: {
      label: limits.label,
      seats: formatLimit(limits.seats),
      monthlyCredits: formatLimit(limits.monthlyCredits),
      maxAgents: formatLimit(limits.maxAgents),
      maxFlows: formatLimit(limits.maxFlows),
      maxIntegrations: formatLimit(limits.maxIntegrations),
      maxSpecialistAreas: formatLimit(limits.maxSpecialistAreas),
    },
    usage: {
      ...usage,
      creditsUsed: tokensToCredits(budget.used),
    },
  })
}
