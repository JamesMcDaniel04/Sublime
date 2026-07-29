import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { limitsForOrg, tokensToCredits, formatLimit, TOKENS_PER_CREDIT } from '@/lib/billing/limits'
import { topupCreditsForMonth, currentUsageMonth } from '@/lib/billing/topups'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { entitlementPlanFor } from '@/lib/billing/entitlements'

export const dynamic = 'force-dynamic'

// Month-to-date usage for the organization: credits/tokens spent against the
// plan allowance plus any purchased top-up credits for the month.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { plan: true, settings: true, createdAt: true, grandfatheredAt: true },
  })
  const plan = entitlementPlanFor(organization)
  const limits = limitsForOrg(plan, organization?.settings)
  const [budget, topupCredits] = await Promise.all([
    checkMonthlyTokenBudget(auth.organizationId),
    topupCreditsForMonth(auth.organizationId),
  ])
  const includedCredits = limits.monthlyCredits
  const totalCredits = Number.isFinite(includedCredits) ? includedCredits + topupCredits : includedCredits
  const creditsUsed = tokensToCredits(budget.used)

  return {
    success: true,
    month: currentUsageMonth(),
    plan,
    tokensPerCredit: TOKENS_PER_CREDIT,
    usage: {
      tokensUsed: budget.used,
      creditsUsed,
      includedCredits: formatLimit(includedCredits),
      topupCredits,
      totalCredits: formatLimit(totalCredits),
      creditsRemaining: Number.isFinite(totalCredits) ? Math.max(0, totalCredits - creditsUsed) : null,
      overLimit: budget.over,
    },
  }
}, { requires: 'member' })
