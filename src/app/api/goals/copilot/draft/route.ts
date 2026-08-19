import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { listMetricSourceOptions } from '@/lib/metrics/available-sources'
import { CopilotDraftError, draftGoalDashboard } from '@/lib/goals/copilot'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { meterTokens } from '@/lib/usage/meter'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'

const bodySchema = z.object({
  description: z.string().min(1, 'Describe the goal.').max(2000),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { description } = bodySchema.parse(
    await request.json().catch(() => ({})),
  )
  // Same guardrails as the other LLM routes: per-user sliding window plus the
  // workspace token budget — a draft loop must not burn unbounded spend.
  const limited = await rateLimit(`goals-copilot-draft:${auth.dbUser.id}`, {
    limit: 10,
    windowMs: 60_000,
  })
  if (!limited.ok) {
    throw new ApiError(
      'Slow down a moment — try the draft again shortly.',
      429,
      'RATE_LIMITED',
    )
  }
  const budget = await checkMonthlyTokenBudget(auth.organizationId)
  if (budget.over) {
    throw new ApiError(
      'Monthly token budget reached for this workspace. Buy additional credits in Settings → Billing or upgrade your plan.',
      429,
      'BUDGET_EXCEEDED',
    )
  }
  const sources = await listMetricSourceOptions(auth)
  try {
    const usage = { total: 0 }
    const { draft, notes } = await draftGoalDashboard({
      description,
      sources,
      onUsage: (u) => { usage.total = u.inputTokens + u.outputTokens },
    })
    // Real provider usage when the call reported it; the character estimate
    // only as a fallback, and flagged as estimated when used.
    void meterTokens({
      organizationId: auth.organizationId,
      tokens: usage.total || Math.ceil((description.length + JSON.stringify(draft).length) / 4),
      path: '/api/goals/copilot/draft',
      estimated: usage.total === 0,
    })
    return { success: true, draft, notes }
  } catch (error) {
    if (error instanceof CopilotDraftError) {
      throw new ApiError(error.message, 422, 'DRAFT_INVALID')
    }
    apiLogger.warn('goals.copilot: draft failed', {
      error:
        error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
    throw new ApiError(
      'The Copilot could not draft this right now — try again, or start from a template below.',
      502,
      'DRAFT_FAILED',
    )
  }
}, { requires: 'member' })
