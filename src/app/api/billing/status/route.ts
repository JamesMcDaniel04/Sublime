import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/auth-utils'
import { billingStateFor } from '@/lib/billing/trial'
import { limitsForOrg, tokensToCredits, formatLimit } from '@/lib/billing/limits'
import { orgUsageSummary } from '@/lib/billing/enforce'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { topupCreditsForMonth } from '@/lib/billing/topups'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'
import { entitlementPlanFor, isGrandfatheredOrganization } from '@/lib/billing/entitlements'
import { trialDaysRemaining } from '@/lib/billing/access'

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
  const entitlementPlan = entitlementPlanFor(organization)
  const limits = limitsForOrg(entitlementPlan, organization.settings)
  const [usage, budget, topupCredits] = await Promise.all([
    orgUsageSummary(organization.id),
    checkMonthlyTokenBudget(organization.id),
    topupCreditsForMonth(organization.id),
  ])

  return NextResponse.json({
    success: true,
    state: billing.state,
    plan: billing.plan,
    grandfathered: isGrandfatheredOrganization(organization),
    hasSubscription: Boolean(organization.stripeSubscriptionId),
    trialEndsAt: organization.trialEndsAt?.toISOString() ?? null,
    trialDaysRemaining: trialDaysRemaining(organization.trialEndsAt),
    capabilities: capabilitiesForPlan(entitlementPlan),
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
      topupCredits,
    },
  })
}
