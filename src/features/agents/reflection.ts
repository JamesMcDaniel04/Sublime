import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { maybeCreateTemplateFromRun } from '@/lib/intelligence/template-from-run'

const ACTION_TYPES = ['connect', 'config', 'data', 'other'] as const

const reflectionSchema = z.object({
  learnings: z.array(z.object({ title: z.string(), content: z.string() })).default([]),
  selfCritique: z.string().default(''),
  suggestions: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        actionType: z
          .string()
          .optional()
          .transform((value) => (value && ACTION_TYPES.includes(value as (typeof ACTION_TYPES)[number]) ? (value as (typeof ACTION_TYPES)[number]) : 'other')),
      }),
    )
    .default([]),
  goalAssessment: z.string().default(''),
  suggestedGoal: z.string().optional(),
  replayable: z
    .object({
      worthTemplating: z.boolean().default(false),
      title: z.string().optional(),
      description: z.string().optional(),
      exampleInput: z.string().optional(),
    })
    .default({ worthTemplating: false }),
})

export type Reflection = z.infer<typeof reflectionSchema>

export const REFLECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    learnings: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] },
    },
    selfCritique: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, rationale: { type: 'string' }, actionType: { type: 'string', enum: [...ACTION_TYPES] } },
        required: ['title', 'rationale'],
      },
    },
    goalAssessment: { type: 'string' },
    suggestedGoal: { type: 'string' },
    replayable: {
      type: 'object',
      properties: {
        worthTemplating: { type: 'boolean' },
        title: { type: 'string' },
        description: { type: 'string' },
        exampleInput: { type: 'string' },
      },
      required: ['worthTemplating'],
    },
  },
  required: ['learnings', 'selfCritique', 'suggestions', 'goalAssessment'],
}

/**
 * Pure: count "actionable" tool-call lines (`^tool: <name>`) in a condensed
 * process log, excluding `ask_user` — the built-in human-clarification tool
 * appended to every run's tool list (see execute-agent.ts's ASK_USER_TOOL).
 * A run that only asked the human a question did no real work, so it must
 * not satisfy the "≥1 tool used" template-worthiness gate in
 * maybeCreateTemplateFromRun.
 */
export function countActionableToolCalls(processLog: string): number {
  const matches = processLog.match(/^tool: (.+)$/gm) || []
  return matches.filter((line) => line.slice('tool: '.length).trim() !== 'ask_user').length
}

/** Tolerant parse: strip fences, find the object, validate. Null on garbage. */
export function parseReflection(raw: string): Reflection | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const result = reflectionSchema.safeParse(JSON.parse(candidate))
      if (result.success) return result.data
    } catch {
      /* try next */
    }
  }
  return null
}

export function buildReflectionPrompt(params: {
  goal: string | null
  objective: string
  summary: string
  processLog: string
}): { system: string; user: string } {
  return {
    system:
      'You are the reflection pass for an autonomous agent. Given a completed run, extract durable learnings (facts about where data lives, what worked, what failed), one short self-critique paragraph the agent should read before its next run, and up to 3 user-actionable suggestions that would help future runs serve the larger goal better (missing connections, data gaps, objective improvements). Be concrete and terse. If no goal was provided, infer one from the objective and return it as suggestedGoal. Also judge replayability: would a reasonable operator want to run this same job again with different inputs? Only true for a self-contained, repeatable job (not a one-off Q&A). If true, return replayable.worthTemplating=true with a short reusable title, a one-paragraph description, and an example input; otherwise return worthTemplating=false.',
    user: [
      `Larger goal: ${params.goal ?? '(none provided — infer one)'}`,
      `Objective: ${params.objective}`,
      `Run summary:\n${params.summary.slice(0, 6000)}`,
      `Process log (condensed):\n${params.processLog.slice(0, 6000)}`,
    ].join('\n\n'),
  }
}

/**
 * Post-run reflection: one structured LLM call, then persist learnings /
 * critique / suggestions as agent memories and emit suggestion events.
 * Fire-and-forget by callers; never throws.
 */
export async function reflectAndRemember(
  params: {
    organizationId: string
    agentId: string
    executionId: string
    goal: string | null
    objective: string
    summary: string
    processLog: string
    recordSuggestionEvent: (payload: Record<string, unknown>) => Promise<void>
    /** The run's owner — templates auto-distilled from this run are attributed to them. */
    userId?: string
    /** The model this run used; carried into the auto-generated template's configuration. */
    model?: string
    /** This agent's connector keys; carried into the auto-generated template's configuration. */
    integrations?: string[]
    /** The agent's category, if any — falls back to 'Auto-generated' for the template's type. */
    category?: string
    /** Whether the run completed successfully; template-from-run is skipped otherwise. Defaults true (the only current caller invokes this from the success path). */
    runSucceeded?: boolean
  },
  deps: { generate?: typeof generateStructured } = {},
): Promise<Reflection | null> {
  try {
    const generate = deps.generate ?? generateStructured
    const { system, user } = buildReflectionPrompt(params)
    // Reflection is a background, non-user-facing pass — run it on the cheap
    // model tier (env-overridable) rather than the full agent model.
    const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
    const raw = await generate({ system, user, schema: REFLECTION_JSON_SCHEMA, schemaName: 'agent_reflection', maxTokens: 1500, model })
    const reflection = parseReflection(raw)
    if (!reflection) return null

    for (const learning of reflection.learnings.slice(0, 5)) {
      await saveAgentMemory({
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: 'learning',
        title: learning.title,
        content: learning.content,
        sourceExecutionId: params.executionId,
      })
    }

    const critique = reflection.selfCritique.trim()
    if (critique || reflection.suggestedGoal) {
      // The latest critique is ALWAYS injected next run — store it on the task
      // metadata (single slot), not as an accumulating memory row. A proposed
      // goal must persist even when there's no critique this run.
      const agent = await prisma.agentTask.findFirst({ where: { id: params.agentId, organizationId: params.organizationId }, select: { metadata: true, goal: true } })
      const metadata = (agent?.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata) ? agent.metadata : {}) as Record<string, unknown>
      await prisma.agentTask.update({
        where: { id: params.agentId, organizationId: params.organizationId },
        data: {
          metadata: {
            ...metadata,
            ...(critique ? { lastCritique: critique.slice(0, 1500) } : {}),
            ...(reflection.suggestedGoal && !agent?.goal ? { suggestedGoal: reflection.suggestedGoal.slice(0, 500) } : {}),
          },
        },
      })
    }

    for (const suggestion of reflection.suggestions.slice(0, 3)) {
      const saved = await saveAgentMemory({
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: 'suggestion',
        title: suggestion.title,
        content: suggestion.rationale,
        sourceExecutionId: params.executionId,
      })
      if (saved) {
        await params
          .recordSuggestionEvent({
            memoryId: saved.id,
            deduped: saved.deduped,
            title: suggestion.title,
            rationale: suggestion.rationale,
            actionType: suggestion.actionType ?? 'other',
          })
          .catch(() => undefined)
      }
    }

    // Best-effort template distillation — never allowed to affect the
    // reflection result or throw into the run.
    if (params.userId) {
      const toolCallCount = countActionableToolCalls(params.processLog)
      await maybeCreateTemplateFromRun({
        organizationId: params.organizationId,
        userId: params.userId,
        agentId: params.agentId,
        executionId: params.executionId,
        objective: params.objective,
        model: params.model || DEFAULT_SUMMARY_MODEL,
        integrations: params.integrations || [],
        category: params.category,
        runSucceeded: params.runSucceeded ?? true,
        toolCallCount,
        replayable: reflection.replayable,
      }).catch((error) => {
        apiLogger.warn('reflectAndRemember: template-from-run failed', {
          organizationId: params.organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }

    return reflection
  } catch (error) {
    apiLogger.warn('reflectAndRemember failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
