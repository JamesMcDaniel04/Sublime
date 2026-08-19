import { z } from 'zod'
import { generateStructured } from '@/lib/llm/model-runner'
import { parseIntegrationMatches, sanitizeIntegrationMatches } from '@/lib/integrations/ai-search'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { meterTokens } from '@/lib/usage/meter'

// Structured-output calls are bounded at ~100s (structuredCallDeadlineMs);
// without an explicit maxDuration the platform default can kill the request
// BEFORE that deadline yields a clean, catchable error - the user saw a raw 504.
export const maxDuration = 120

const BodySchema = z.object({
  query: z.string().min(3).max(500),
  items: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
  })).min(1).max(200),
})

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
      },
    },
  },
  required: ['matches'],
} as const

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { query, items } = BodySchema.parse(await request.json())
  const budget = await checkMonthlyTokenBudget(auth.organizationId, auth.dbUser.id)
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace. Buy additional credits in Settings → Billing or upgrade your plan.', 429, 'BUDGET_EXCEEDED')
  const usage = { total: 0 }
  let raw: string
  try {
    const usage = { total: 0 }
    raw = await generateStructured({
    onUsage: (u) => { usage.total = u.inputTokens + u.outputTokens },
      schemaName: 'integration_recommendations',
      schema: RESULT_SCHEMA as unknown as Record<string, unknown>,
      system: [
        'Recommend the integrations that best help accomplish the user goal.',
        'Recommend multiple complementary integrations when the workflow needs them, but never add an irrelevant app.',
        'Rank the most important first, return at most 6, and explain each choice in one short sentence.',
        'Only return IDs from the supplied catalog. An empty result is valid.',
      ].join(' '),
      user: `Goal: ${query}\n\nAvailable integrations:\n${items.map((item) => `${item.id} | ${item.name} | ${item.description.slice(0, 240)}`).join('\n')}`,
      maxTokens: 1200,
    })
  } catch (error) {
    throw new ApiError('AI integration search is not configured for this workspace.', 503, 'AI_SEARCH_UNAVAILABLE', error)
  }

  // Rough metering (~chars/4) since generateStructured returns no token usage.
  // Real provider usage when the call reported it; the character estimate
  // only as a fallback, and flagged as estimated when used.
  void meterTokens({
    organizationId: auth.organizationId,
    tokens: usage.total || Math.ceil((query.length + raw.length) / 4),
    path: '/api/integrations/ai-search',
    estimated: usage.total === 0,
  })
  return { success: true, matches: sanitizeIntegrationMatches(parseIntegrationMatches(raw), items) }
}, { requires: 'member', rateLimit: { feature: 'ai-search', perUser: 20 } })
