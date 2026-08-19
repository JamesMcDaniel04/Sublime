import { z } from 'zod'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { generateStructured } from '@/lib/llm/model-runner'
import { qwenConfigured } from '@/lib/llm/qwen'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { meterTokens } from '@/lib/usage/meter'
import { createAgentFromDraft, normalizeDraft, type AgentDraft } from '@/features/agents/create-from-draft'
import { AUTHORING_SAFETY } from '@/lib/llm/guardrails'

// Structured-output calls are bounded at ~100s (structuredCallDeadlineMs);
// without an explicit maxDuration the platform default can kill the request
// BEFORE that deadline yields a clean, catchable error - the user saw a raw 504.
export const maxDuration = 120

// The integration vocabulary the model may pick from: every registry key
// (deduped case-insensitively — the builtin 'Slack' and the nango 'slack'
// capability are the same selection string to the runtime's matcher).
const PROVIDERS = [...new Map(BUILTIN_CONNECTORS.map((c) => [c.key.toLowerCase(), c.key])).values()]

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short agent name, e.g. "Weekly Report Agent".' },
    icon: { type: 'string', description: 'A single emoji that represents the agent, e.g. "📄" or "💰".' },
    description: { type: 'string', description: 'One sentence describing what the agent does.' },
    instructions: {
      type: 'string',
      description: 'Detailed operating instructions for the agent, written in second person, covering goal, steps, tools to use, and what the final report should contain.',
    },
    integrations: {
      type: 'array',
      items: { type: 'string', enum: [...PROVIDERS] },
      description: 'Only the integrations the task actually requires.',
    },
    schedule: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['manual', 'hourly', 'daily', 'weekly', 'cron'] },
        time: { type: 'string', description: '24h HH:MM start time; empty string when not applicable.' },
        cron: { type: 'string', description: 'Cron expression; empty string unless type is "cron".' },
        timezone: { type: 'string', description: 'IANA timezone, default UTC.' },
        isActive: { type: 'boolean', description: 'True when the user described a recurring cadence.' },
      },
      required: ['type', 'time', 'cron', 'timezone', 'isActive'],
    },
  },
  required: ['title', 'icon', 'description', 'instructions', 'integrations', 'schedule'],
} as const

// Den-style natural-language agent builder: describe the job, get a ready
// agent config. Pass { create: true } to save it immediately.
export const POST = withAuthenticatedApi(async (request, auth) => {
  if (!process.env.ANTHROPIC_API_KEY && !qwenConfigured()) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const { description, create } = z.object({
    description: z.string().min(10).max(4000),
    create: z.boolean().default(false),
  }).parse(await request.json())

  // Counts against the workspace token budget — block when already over.
  const budget = await checkMonthlyTokenBudget(auth.organizationId)
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')

  const usage = { total: 0 }
  const text = await generateStructured({
    onUsage: (u) => { usage.total = u.inputTokens + u.outputTokens },
    schemaName: 'agent_draft',
    schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
    system: [
      AUTHORING_SAFETY,
      'You configure autonomous agents for a team workspace. Turn the user\'s plain-language description into an agent configuration.',
      `Available integrations: ${PROVIDERS.join(', ')}. Include only the ones the task needs; an agent with no integrations is fine.`,
      'Write instructions the agent can follow without further clarification: the goal, the steps, which tools to use, and what to include in the final report. If anything is genuinely ambiguous, instruct the agent to ask the user via its ask_user tool at run time.',
      'Set a schedule only when the user describes a recurring cadence; otherwise use type "manual" with isActive false.',
    ].join('\n'),
    user: description,
  })

  if (!text) throw new ApiError('The model returned no draft', 502, 'DRAFT_FAILED')
  // Rough metering (~chars/4) since generateStructured returns no token usage.
  // Real provider usage when the call reported it; the character estimate
  // only as a fallback, and flagged as estimated when used.
  void meterTokens({
    organizationId: auth.organizationId,
    tokens: usage.total || Math.ceil((description.length + text.length) / 4),
    path: '/api/agents/draft',
    estimated: usage.total === 0,
  })
  const draft = JSON.parse(text) as AgentDraft

  if (!create) {
    return { success: true, draft: normalizeDraft(draft) }
  }

  const { agent, draft: enrichedDraft } = await createAgentFromDraft(draft, {
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
  })
  return { success: true, draft: enrichedDraft, agentId: agent.id }
}, { requires: 'member', rateLimit: { feature: 'agents-draft', perUser: 10 } })
