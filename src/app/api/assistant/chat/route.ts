import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { generateStructured } from '@/lib/llm/model-runner'
import { qwenConfigured } from '@/lib/llm/qwen'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope } from '@/lib/server/visibility'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { createAgentFromDraft, type AgentDraft } from '@/features/agents/create-from-draft'
import { buildWorkspaceContext } from '@/features/assistant/workspace-context'
import { buildAssistantIntelligence } from '@/features/assistant/intelligence-context'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { deriveTitle, serializeMessage } from './shared'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * Workspace-level Home assistant chat. GET returns a conversation, POST
 * answers with server-assembled workspace context and may CREATE an agent
 * (from an aligned assignment) or flag an execute action the client fires
 * against the existing /api/agents/[id]/execute endpoint. PATCH records the
 * resulting run on the message so the transcript renders it after reload.
 */

const PROVIDERS = [...new Map(BUILTIN_CONNECTORS.map((c) => [c.key.toLowerCase(), c.key])).values()]

const SYSTEM_PROMPT = [
  'You are the Sublime home assistant for a team workspace. You oversee the workspace: its agents, their recent runs, connected integrations, and flows.',
  'Ground every statement in the provided context. If the context does not contain the answer, say so plainly.',
  'The payload may include an "intelligence" section: retrieved workspace knowledge, OBSERVED usage patterns (evidence-gated facts with real counts and dates), and at most one pending suggestion. Use it to extrapolate from how this user actually works — reference patterns naturally when relevant, never as prescriptions. Mention the pending suggestion only when it relates to the question; the user accepts or dismisses it in the UI, not here.',
  'When the user shares an assignment (as text or an attached file) and wants it handled, turn it into an agent. First check the delivery requirements: output format, cadence or schedule, destinations or integrations, and scope. If any of these are genuinely ambiguous, ask ONE batch of short clarifying questions in the reply and set agentDraft to null. Once requirements are clear — or the assignment already answers them — set agentDraft to the complete configuration. Never ask clarifying questions and emit agentDraft in the same turn.',
  `Available integrations: ${PROVIDERS.join(', ')}. Include only the ones the task needs; an agent with no integrations is fine.`,
  'agentDraft.instructions must be complete operating instructions in second person: the goal, the steps, which tools to use, and what the final output must contain. If minor details remain open, instruct the agent to ask the user via its ask_user tool at run time.',
  'When you emit agentDraft the agent is created immediately and shown to the user with a Run button — never claim you cannot create agents, and never emit agentDraft merely as an example.',
  'Set a schedule only when the user describes a recurring cadence; otherwise use type "manual" with isActive false.',
  'Set action to { "type": "execute", "agentId": "<id from the context agents list>" } ONLY when the user explicitly asks to run an agent. Otherwise action is null. Never invent agent ids.',
  'Write concise markdown in sentence case. No emoji.',
].join('\n')

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: {
      type: 'string',
      description: 'The answer shown to the user, in concise markdown. Sentence case, no emoji.',
    },
    agentDraft: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'A complete agent configuration once assignment requirements are aligned; null otherwise.',
      properties: {
        title: { type: 'string', description: 'Short agent name, e.g. "Weekly Report Agent".' },
        icon: { type: 'string', description: 'A single emoji that represents the agent.' },
        description: { type: 'string', description: 'One sentence describing what the agent does.' },
        instructions: { type: 'string', description: 'Complete operating instructions in second person.' },
        integrations: { type: 'array', items: { type: 'string', enum: [...PROVIDERS] } },
        schedule: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['manual', 'hourly', 'daily', 'weekly', 'cron'] },
            time: { type: 'string', description: '24h HH:MM start time; empty string when not applicable.' },
            cron: { type: 'string', description: 'Cron expression; empty string unless type is "cron".' },
            timezone: { type: 'string', description: 'IANA timezone, default UTC.' },
            isActive: { type: 'boolean' },
          },
          required: ['type', 'time', 'cron', 'timezone', 'isActive'],
        },
      },
      required: ['title', 'icon', 'description', 'instructions', 'integrations', 'schedule'],
    },
    action: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'An action for the client to perform, or null.',
      properties: {
        type: { type: 'string', enum: ['execute'] },
        agentId: { type: 'string', description: 'Id of an agent from the context agents list.' },
      },
      required: ['type', 'agentId'],
    },
  },
  required: ['reply', 'agentDraft', 'action'],
} as const

const draftSchema = z.object({
  title: z.string().min(1),
  icon: z.string().default(''),
  description: z.string().default(''),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  schedule: z.object({
    type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron']),
    time: z.string().default(''),
    cron: z.string().default(''),
    timezone: z.string().default('UTC'),
    isActive: z.boolean().default(false),
  }),
})

const actionSchema = z.object({ type: z.literal('execute'), agentId: z.string().min(1) })

export const GET = withAuthenticatedApi(async (request, auth) => {
  const requested = new URL(request.url).searchParams.get('sessionId')
  let sessionId = requested
  if (!sessionId) {
    const latest = await prisma.assistantChatSession.findFirst({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })
    sessionId = latest?.id ?? null
  }
  if (!sessionId) return { success: true, sessionId: null, messages: [] }
  const rows = await prisma.assistantChatMessage.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, sessionId },
    // Secondary id sort keeps user/assistant pairs stable when both rows land
    // in the same millisecond (cuids are creation-ordered within a process).
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  })
  return { success: true, sessionId, messages: rows.reverse().map(serializeMessage) }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  if (!process.env.ANTHROPIC_API_KEY && !qwenConfigured()) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const { message, sessionId: requestedSessionId, attachment } = z
    .object({
      message: z.string().min(1).max(4000),
      sessionId: z.string().optional(),
      attachment: z
        .object({
          filename: z.string().min(1).max(200),
          text: z.string().min(1).max(24_000),
          truncated: z.boolean().optional(),
        })
        .optional(),
    })
    .parse(await request.json())

  const limited = await rateLimit(`assistant-chat:${auth.dbUser.id}`, { limit: 30, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Rate limit exceeded', 429, 'RATE_LIMITED')
  const budget = await checkMonthlyTokenBudget(auth.organizationId)
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')

  let session = requestedSessionId
    ? await prisma.assistantChatSession.findFirst({
        where: { id: requestedSessionId, organizationId: auth.organizationId, userId: auth.dbUser.id },
      })
    : null
  if (!session) {
    session = await prisma.assistantChatSession.create({
      data: { organizationId: auth.organizationId, userId: auth.dbUser.id, title: deriveTitle(message) },
    })
  }

  const [context, intelligence, historyRows] = await Promise.all([
    buildWorkspaceContext(auth),
    buildAssistantIntelligence({ organizationId: auth.organizationId, userId: auth.dbUser.id, query: message }),
    prisma.assistantChatMessage.findMany({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id, sessionId: session.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    }),
  ])
  const conversation = historyRows.reverse().map((row) => {
    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {}
    const stored = metadata.attachment as { filename?: string; text?: string } | undefined
    // Re-inline earlier attachments (clipped) so follow-up turns keep the
    // assignment in view without resending it from the client.
    const suffix = stored?.text ? `\n\n[Attached ${stored.filename}]\n${stored.text.slice(0, 4000)}` : ''
    return { role: row.role, content: `${row.content.slice(0, 2000)}${suffix}` }
  })

  let reply = ''
  let draft: z.infer<typeof draftSchema> | null = null
  let action: z.infer<typeof actionSchema> | null = null
  try {
    const text = await generateStructured({
      schemaName: 'home_assistant_reply',
      schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      system: SYSTEM_PROMPT,
      user: JSON.stringify({
        context,
        ...(intelligence ? { intelligence } : {}),
        conversation,
        question: message,
        ...(attachment ? { attachment } : {}),
      }),
      // A draft reply includes complete agent instructions inline — a tight
      // cap truncates the JSON and turns a valid answer into a parse failure.
      maxTokens: 8192,
    })
    const parsed = JSON.parse(text || '{}') as { reply?: unknown; agentDraft?: unknown; action?: unknown }
    reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
    draft = draftSchema.nullish().catch(null).parse(parsed.agentDraft ?? null) ?? null
    action = actionSchema.nullish().catch(null).parse(parsed.action ?? null) ?? null
  } catch (error) {
    // Preserve the real cause so the 5xx handler logs/reports it.
    throw new ApiError('The assistant could not respond. Try again.', 502, 'ASSISTANT_FAILED', error)
  }

  // Auto-apply: an aligned draft becomes a real agent immediately; the reply
  // renders a created-agent card with a Run button. A creation failure keeps
  // the conversation (and the draft's content, via the reply text) intact.
  let createdAgent: { id: string; title: string; icon: string; description: string } | null = null
  if (draft) {
    try {
      const created = await createAgentFromDraft(draft as AgentDraft, {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
      })
      createdAgent = {
        id: created.agent.id,
        title: created.draft.title,
        icon: created.draft.icon,
        description: created.draft.description,
      }
      await recordUserEvent({
        organizationId: auth.organizationId, userId: auth.dbUser.id,
        kind: 'agent_created', resourceType: 'agent', resourceId: created.agent.id,
        context: { via: 'assistant', name: created.draft.title },
      })
    } catch {
      reply = `${reply}\n\nI could not save the agent just now — ask me to create it again.`
    }
  }

  // Execute requests: validate the id against this user's visible ACTIVE
  // agents; the client fires the existing execute endpoint (inline runs can
  // take minutes — far too long to hold this response open).
  let validatedAction: { type: 'execute'; agentId: string } | null = null
  if (action) {
    const target = await prisma.agentTask.findFirst({
      where: { id: action.agentId, organizationId: auth.organizationId, status: 'ACTIVE', ...agentReadScope(auth.dbUser.id) },
      select: { id: true },
    })
    if (target) validatedAction = { type: 'execute', agentId: target.id }
    else reply = `${reply}\n\nI could not find that agent in this workspace, so I did not start a run.`
  }

  if (!reply) reply = createdAgent ? 'Here is the agent I set up.' : 'No answer returned.'

  // Rough metering (~chars/4): generateStructured returns no token usage.
  void recordTokenUsage(
    auth.organizationId,
    Math.ceil(
      (JSON.stringify(context).length + message.length + (attachment?.text.length ?? 0) + reply.length) / 4,
    ),
  ).catch(() => undefined)

  const userMessage = await prisma.assistantChatMessage.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'user',
      content: message,
      ...(attachment ? { metadata: { attachment } as unknown as Prisma.InputJsonValue } : {}),
    },
  })
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'assistant_prompt', resourceType: 'assistant_message', resourceId: userMessage.id,
    context: { sessionId: userMessage.sessionId },
  })
  const assistantMetadata: Record<string, unknown> = {}
  if (createdAgent) assistantMetadata.createdAgent = createdAgent
  if (validatedAction) assistantMetadata.action = validatedAction
  const assistantMessage = await prisma.assistantChatMessage.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'assistant',
      content: reply,
      ...(Object.keys(assistantMetadata).length
        ? { metadata: assistantMetadata as unknown as Prisma.InputJsonValue }
        : {}),
    },
  })

  // Bump the session so it sorts to the top of history. Best-effort.
  await prisma.assistantChatSession
    .update({ where: { id: session.id }, data: { title: session.title ?? deriveTitle(message) } })
    .catch(() => undefined)

  return {
    success: true,
    sessionId: session.id,
    messages: [serializeMessage(userMessage), serializeMessage(assistantMessage)],
  }
})

// Records the run the client started off an execute action (or a created-agent
// Run click) so the transcript still shows it after a reload.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const { messageId, executedRun } = z
    .object({
      messageId: z.string().min(1),
      executedRun: z.object({
        executionId: z.string().min(1),
        agentId: z.string().min(1),
        status: z.string().min(1).max(40),
      }),
    })
    .parse(await request.json())
  const row = await prisma.assistantChatMessage.findFirst({
    where: { id: messageId, organizationId: auth.organizationId, userId: auth.dbUser.id },
  })
  if (!row) throw new ApiError('Message not found', 404, 'NOT_FOUND')
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  const updated = await prisma.assistantChatMessage.update({
    where: { id: row.id },
    data: { metadata: { ...metadata, executedRun } as unknown as Prisma.InputJsonValue },
  })
  return { success: true, message: serializeMessage(updated) }
})
