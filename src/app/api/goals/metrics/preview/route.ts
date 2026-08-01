import { z } from 'zod'
import { getMetricSource } from '@/lib/metrics/registry'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'

export const runtime = 'nodejs'

const bodySchema = z.object({
  source: z.enum([
    'stripe',
    'hubspot',
    'salesforce',
    'google_sheets',
    'google_analytics',
    'postgres',
    'url',
    'slack_assisted',
    'gmail_assisted',
    'manual',
  ]),
  metricKey: z.string().min(1),
  connectionRef: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json().catch(() => ({})))
  if (body.source === 'manual') {
    throw new ApiError('Manual metrics have no preview', 400, 'NO_PREVIEW')
  }
  const adapter = getMetricSource(body.source)
  if (!adapter) throw new ApiError('Metric source is unavailable', 400, 'SOURCE_UNAVAILABLE')
  // Assisted previews run LLM extraction over mailbox/channel history — the
  // workspace token ceiling applies. Non-assisted sources are plain reads and
  // stay available even when the budget is exhausted.
  if (body.source === 'slack_assisted' || body.source === 'gmail_assisted') {
    const budget = await checkMonthlyTokenBudget(auth.organizationId, auth.dbUser.id)
    if (budget.over) throw new ApiError('Monthly token budget reached for this workspace. Buy additional credits in Settings → Billing or upgrade your plan.', 429, 'BUDGET_EXCEEDED')
  }
  try {
    const reading = await adapter.fetchValue(
      {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        connectionRef: body.connectionRef ?? null,
        config: body.config,
      },
      body.metricKey,
    )
    return { success: true, value: reading.value, asOf: reading.asOf }
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Preview failed',
      400,
      'PREVIEW_FAILED',
      error,
    )
  }
}, { requires: 'member', rateLimit: { feature: 'goals-metrics-preview', perUser: 20 } })
