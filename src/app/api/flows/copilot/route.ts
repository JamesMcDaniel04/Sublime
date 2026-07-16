import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { generateFlowGraph } from '@/lib/flows/copilot-generate'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'

const requestSchema = z.object({
  description: z.string().min(1),
  currentGraph: z.unknown().optional(),
  issues: z.array(z.string()).max(50).optional(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  // Copilot generation is a full LLM call — same guardrails as agent execute.
  const limited = await rateLimit(`copilot:${auth.dbUser.id}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Rate limit exceeded', 429, 'RATE_LIMITED')
  const budget = await checkMonthlyTokenBudget(auth.organizationId, auth.dbUser.id)
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')
  const { description, currentGraph, issues } = requestSchema.parse(await request.json())
  const { roster, toolCatalog, contextBlock, graphRules } = await buildCopilotGrounding(auth.organizationId, auth.dbUser.id)
  const system = graphRules

  // REPAIR MODE: an existing graph plus checker issues to fix in place, rather
  // than describing a brand-new flow. Falls back to generate mode when the
  // graph is missing/invalid or no issues were supplied.
  const parsedCurrentGraph = currentGraph !== undefined ? flowGraphSchema.safeParse(currentGraph) : undefined
  const isRepairMode = Boolean(parsedCurrentGraph?.success && issues?.length)

  const user = isRepairMode
    ? [
        `Current flow graph JSON:\n${JSON.stringify(parsedCurrentGraph!.data)}`,
        '',
        `This existing flow has these validation problems:\n${issues!.map((issue) => `- ${issue}`).join('\n')}`,
        'Return the SAME flow with the minimal changes needed to fix every problem. Keep node ids, structure, and configured values wherever possible; do not redesign the flow.',
        '',
        contextBlock,
      ].join('\n')
    : [`Build a flow that: ${description}`, '', contextBlock].join('\n')

  try {
    const { graph, validation, needsAttention } = await generateFlowGraph({ system, user, roster, toolCatalog })
    return { success: true, graph, validation, needsAttention }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not generate a runnable flow.',
      graph: emptyGraph(),
    }
  }
})
