import type { AgentChatMessage, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { createModelRunner, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { runCopilotLoop, type CopilotStreamEvent } from '@/lib/llm/copilot-loop'
import { sseResponse } from '@/lib/server/sse'
import { qwenConfigured } from '@/lib/llm/qwen'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { buildAssistantContext } from '@/features/agents/assistant-context'
import { buildAgentCopilotTools, PROPOSE_CONFIG_TOOL } from '@/features/agents/copilot-tools'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { agentIdFromRequest, requireAgent, deriveTitle, LEGACY_SESSION_ID } from './shared'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * Agent-scoped assistant chat. Extends the per-execution follow-up chat
 * (/api/chat) to a persistent per-agent thread: GET returns the thread,
 * POST answers with server-assembled run context and may return a config
 * proposal, PATCH marks a proposal as applied (the client applies it via the
 * existing PUT /api/agents after an explicit confirm).
 */

const SYSTEM_PROMPT = [
  "You are the Sublime assistant for a single agent. You answer questions about the agent's recent runs, help debug failures, and turn natural-language requests into configuration changes.",
  'Ground every statement in the provided context and your lookups. You have read-only tools: list_runs, get_run, get_step_output, get_tool_schema, list_workspace_agents. Use them whenever the provided context does not already contain the answer — never say the context is missing something you could look up. You have at most 6 lookups per turn; investigate the most diagnostic thing first.',
  'When the user asks to change the agent — its instructions/objective, schedule, skills, connected tools/integrations, model, name, or description — call propose_config_change ONCE with only the fields that should change and every other field null. The instructions field must contain the complete updated instructions text, not a diff. Never claim a change was applied; the user reviews and confirms it in the interface.',
  'When the message is not a change request, answer in plain text and do not call propose_config_change.',
  'When debugging, find the latest failed run: quote the relevant error and the tool calls around it.',
  'Write concise markdown in sentence case. No emoji.',
].join('\n')

// The proposal's JSON schema lives on PROPOSE_CONFIG_TOOL.inputSchema — the
// model emits it as a terminal tool call at the end of the read-tool loop.
const proposalSchema = z
  .object({
    summary: z.string().default(''),
    title: z.string().nullish(),
    description: z.string().nullish(),
    instructions: z.string().nullish(),
    model: z.string().nullish(),
    integrations: z.array(z.string()).nullish(),
    skills: z.array(z.string()).nullish(),
    schedule: z
      .object({
        type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron']),
        time: z.string().default(''),
        cron: z.string().default(''),
        timezone: z.string().default('UTC'),
        isActive: z.boolean().default(false),
      })
      .nullish(),
  })
  .nullish()

/** Drop null/empty fields; returns null when nothing actionable remains. */
function normalizeProposal(raw: z.infer<typeof proposalSchema>) {
  if (!raw) return null
  const changes: Record<string, unknown> = {}
  if (raw.title?.trim()) changes.title = raw.title.trim()
  if (raw.description?.trim()) changes.description = raw.description.trim()
  if (raw.instructions?.trim()) changes.instructions = raw.instructions.trim()
  if (raw.model?.trim()) changes.model = raw.model.trim()
  if (raw.integrations) changes.integrations = raw.integrations
  if (raw.skills) changes.skills = raw.skills
  if (raw.schedule) {
    changes.schedule = {
      type: raw.schedule.type,
      timezone: raw.schedule.timezone || 'UTC',
      isActive: raw.schedule.type === 'manual' ? false : raw.schedule.isActive,
      ...(raw.schedule.time ? { time: raw.schedule.time } : {}),
      ...(raw.schedule.cron ? { cron: raw.schedule.cron } : {}),
    }
  }
  if (!Object.keys(changes).length) return null
  return { summary: raw.summary?.trim() || 'Configuration update', ...changes }
}

function serializeMessage(message: AgentChatMessage) {
  const metadata =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : {}
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    proposal: metadata.proposal ?? null,
    appliedAt: metadata.appliedAt ?? null,
  }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = agentIdFromRequest(request)
  await requireAgent(agentId, auth)
  const requested = new URL(request.url).searchParams.get('sessionId')

  // Resolve which conversation to return: explicit session, else the most
  // recent one, else the legacy flat thread (if any), else empty (new chat).
  let sessionId: string | null = requested
  if (!sessionId) {
    const latest = await prisma.agentChatSession.findFirst({
      where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })
    if (latest) {
      sessionId = latest.id
    } else {
      const legacyCount = await prisma.agentChatMessage.count({
        where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId: null },
      })
      sessionId = legacyCount > 0 ? LEGACY_SESSION_ID : null
    }
  }

  let rows: AgentChatMessage[] = []
  if (sessionId) {
    rows = await prisma.agentChatMessage.findMany({
      where:
        sessionId === LEGACY_SESSION_ID
          ? { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId: null }
          : { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId },
      // Secondary id sort keeps user/assistant pairs stable when both rows land
      // in the same millisecond (cuids are creation-ordered within a process).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    })
  }
  return { success: true, sessionId, messages: rows.reverse().map(serializeMessage) }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  if (!process.env.ANTHROPIC_API_KEY && !qwenConfigured()) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const agentId = agentIdFromRequest(request)
  const { message, sessionId: requestedSessionId } = z
    .object({ message: z.string().min(1).max(4000), sessionId: z.string().optional() })
    .parse(await request.json())
  const agent = await requireAgent(agentId, auth)

  // Assistant chat counts against the workspace token budget too — block when
  // the org is already over so chat can't bypass the ceiling.
  const budget = await checkMonthlyTokenBudget(auth.organizationId)
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')

  // Resolve the target conversation. An explicit, owned session is reused;
  // otherwise (absent, legacy, or unknown) a new session starts — the legacy
  // flat thread stays read-only history.
  let session =
    requestedSessionId && requestedSessionId !== LEGACY_SESSION_ID
      ? await prisma.agentChatSession.findFirst({
          where: { id: requestedSessionId, organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id },
        })
      : null
  if (!session) {
    session = await prisma.agentChatSession.create({
      data: {
        agentTaskId: agentId,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        title: deriveTitle(message),
      },
    })
  }

  const [context, historyRows] = await Promise.all([
    buildAssistantContext(agent, message, auth.dbUser.id),
    prisma.agentChatMessage.findMany({
      where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId: session.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    }),
  ])
  const conversation = historyRows
    .reverse()
    .map((row) => ({ role: row.role, content: row.content.slice(0, 2000) }))

  const runTurn = async (emit: (event: CopilotStreamEvent) => void) => {
  let reply = ''
  let proposal: Record<string, unknown> | null = null
  let loopUsage = 0
  try {
    const runner = createModelRunner(DEFAULT_SUMMARY_MODEL)
    const transcript = runner.start(JSON.stringify({ context, conversation, question: message }))
    const loop = await runCopilotLoop({
      runner,
      system: SYSTEM_PROMPT,
      transcript,
      readTools: buildAgentCopilotTools({ agentId, organizationId: auth.organizationId, userId: auth.dbUser.id }),
      terminalTool: PROPOSE_CONFIG_TOOL,
      emit,
    })
    reply = loop.text.trim()
    loopUsage = loop.usage.inputTokens + loop.usage.outputTokens
    proposal = normalizeProposal(proposalSchema.catch(null).parse(loop.terminalCall ?? null))
  } catch (error) {
    // Preserve the real cause so the 5xx handler logs/reports it — a bare catch
    // made this failure invisible in logs and Sentry.
    throw new ApiError('The assistant could not respond. Try again.', 502, 'ASSISTANT_FAILED', error)
  }
  if (!reply) reply = proposal ? 'Here is the proposed configuration change.' : 'No answer returned.'

  // Persist only after the model answered, so a failed call leaves no
  // half-thread behind (the client restores the input for a retry).
  // Real usage summed across the loop's hops — the old chars/4 estimate is gone.
  void recordTokenUsage(auth.organizationId, loopUsage).catch(() => undefined)

  const userMessage = await prisma.agentChatMessage.create({
    data: {
      agentTaskId: agentId,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'user',
      content: message,
    },
  })
  const assistantMessage = await prisma.agentChatMessage.create({
    data: {
      agentTaskId: agentId,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'assistant',
      content: reply,
      ...(proposal ? { metadata: { proposal } as unknown as Prisma.InputJsonValue } : {}),
    },
  })
  // Memory writeback (seam 7): durable user guidance given in chat should
  // inform future RUNS, not just this conversation. Declarative statements
  // (long enough, not a question) are saved as user_answer memories;
  // saveAgentMemory embeds + dedupes + caps, so casual chatter can't flood it.
  const trimmedMessage = message.trim()
  if (trimmedMessage.length >= 40 && !trimmedMessage.endsWith('?')) {
    const lastAssistant = [...conversation].reverse().find((row) => row.role === 'assistant')
    void saveAgentMemory({
      organizationId: auth.organizationId,
      agentId,
      kind: 'user_answer',
      title: deriveTitle(trimmedMessage),
      content: trimmedMessage,
      ...(lastAssistant ? { question: lastAssistant.content.slice(0, 500) } : {}),
    }).catch(() => undefined)
  }

  // Bump the session so it sorts to the top of history (and set its title on the
  // first message). Best-effort — ordering is cosmetic, not correctness.
  await prisma.agentChatSession
    .update({ where: { id: session.id }, data: { title: session.title ?? deriveTitle(message) } })
    .catch(() => undefined)

  return { success: true, sessionId: session.id, messages: [serializeMessage(userMessage), serializeMessage(assistantMessage)] }
  }

  // Content negotiation: SSE when the client asks for it, the legacy JSON
  // body otherwise (existing tests and non-UI callers stay on the old path).
  if (request.headers.get('accept')?.includes('text/event-stream')) {
    return sseResponse(async (emit) => {
      const payload = await runTurn(emit as (event: CopilotStreamEvent) => void)
      emit({ type: 'result', ...payload })
    })
  }
  return runTurn(() => undefined)
}, { requires: 'member', rateLimit: { feature: 'agent-chat', perUser: 30 } })

// Marks a proposal message as applied after the client has confirmed the
// change through the existing PUT /api/agents update endpoint.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const agentId = agentIdFromRequest(request)
  const { messageId } = z.object({ messageId: z.string().min(1) }).parse(await request.json())
  await requireAgent(agentId, auth)

  const row = await prisma.agentChatMessage.findFirst({
    where: { id: messageId, organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id },
  })
  if (!row) throw new ApiError('Message not found', 404, 'NOT_FOUND')
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  const updated = await prisma.agentChatMessage.update({
    where: { id: row.id, organizationId: auth.organizationId },
    data: { metadata: { ...metadata, appliedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue },
  })
  return { success: true, message: serializeMessage(updated) }
}, { requires: 'member' })
