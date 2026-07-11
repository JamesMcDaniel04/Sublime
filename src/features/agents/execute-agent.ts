import type { Job } from 'bullmq'
import { createHash } from 'node:crypto'
import { prisma, systemPrisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'
import { createApproval, requiresApproval } from '@/lib/agents/approval'
import { retrieveContext, renderContext } from '@/lib/rag/retrieve'
import { createContextAssembler } from '@/lib/context/assemble'
import { retrieveKnowledge, renderKnowledge } from '@/lib/knowledge/retrieve'
import { embeddingsConfigured, embedQuery, embedTexts, cosineSimilarity } from '@/lib/rag/embeddings'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { indexExecution } from '@/lib/rag/indexer'
import { selectedStrataServers } from '@/lib/mcp/strata'
import {
  loadKlavisPlaneGroups,
  loadMcpConnectionPlaneGroups,
  loadNativePlaneGroups,
  loadNangoPlaneGroups,
  toolName,
  type McpToolClient,
  type ToolBinding,
  type ToolPlaneGroup,
} from './tool-planes'
import { resolveAgentConnectorKeys } from '@/lib/connectors/agent-connectors'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { notify } from '@/lib/notifications/service'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { buildAgentSystemPrompt } from './system-prompt'
import { structuredResponseInstruction, parseStructuredAgentOutput } from '@/features/flows/agent-response'
import type { OutputField } from '@/lib/flows/graph'
import {
  createModelRunner,
  generateHeadline,
  DEFAULT_AGENT_MODEL,
  type ToolDefinition,
  type ToolResult,
} from '@/lib/llm/model-runner'
import { coerceToIR } from '@/lib/llm/ir'
import { retrieveAgentMemory, renderAgentMemories, bestAnswerMatch, markMemoriesUsed, saveAgentMemory } from '@/lib/memory/agent-memory'
import { findOrgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'
import { reflectAndRemember } from './reflection'
import { shouldStrategize, goalSection, strategizeSection, STRATEGIZE_RETRIEVAL } from './strategy'

export type AgentExecutionJob = {
  executionId?: string
  agentId: string
  organizationId: string
  userId: string
  input?: string
  resume?: boolean
  reply?: string
  // Multi-agent handoff: depth in the sub-agent chain (0 = top-level) and the
  // ancestor agent ids, used to bound recursion and prevent cycles.
  depth?: number
  ancestorAgentIds?: string[]
}

// Sub-agent handoff bounds. Kept conservative: sub-runs execute inline within
// the parent's tool loop, so many/deep runs would blow the run's time budget.
const MAX_SUBAGENT_DEPTH = 2
const MAX_SUBAGENTS_PER_RUN = 15

type PendingQuestion = {
  toolCallId: string
  question: string
  stepId: string | null
  collectedResults: ToolResult[]
}

const ASK_USER_TOOL: ToolDefinition = {
  name: 'ask_user',
  description:
    'Pause the run and ask the user one question. Call this only when you are blocked on a decision, missing information, or approval that only the user can provide. The run resumes when they reply.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show the user.' },
    },
    required: ['question'],
  },
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

// Re-exported for callers that historically imported these from here (the
// definitions moved to ./tool-planes, shared with the flow tool catalog).
export { toolDiscoveryCacheKey } from './tool-planes'

function metadataOf(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

// ── Idempotency ledger (durable resume) ──────────────────────────────────────
// A tool call is keyed by its node + a stable hash of its input. On resume, a
// re-issued call whose key matches an already-succeeded step replays that step's
// stored output instead of re-executing (and re-firing side effects).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function toolStepKey(node: string, input: unknown): string {
  return `${node}:${createHash('sha256').update(stableStringify(input)).digest('hex')}`
}

async function loadCompletedToolSteps(executionId: string): Promise<Map<string, unknown>> {
  const steps = await prisma.workflowStep.findMany({
    where: { executionId, status: 'succeeded' },
    select: { node: true, input: true, output: true },
  })
  const map = new Map<string, unknown>()
  for (const step of steps) map.set(toolStepKey(step.node, step.input), step.output)
  return map
}

// A tool discovered from some plane, before the global cap is applied. `isWrite`
// marks consequential outbound-delivery tools so they can be reserved a slice of
// the cap instead of being crowded out by many read tools.
export type DiscoveredTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  binding: ToolBinding
  isWrite: boolean
}

const TOOL_CAP = 64
const WRITE_RESERVE = 16

/**
 * Apply the global tool cap with a reserved write-tool budget: keep all write
 * tools (up to WRITE_RESERVE), then fill the rest with reads up to TOOL_CAP,
 * then any remaining writes. Dedupes by name (first wins). This is the single
 * place the cap/priority policy lives — previously each plane capped inline, so
 * write tools (loaded last) were silently dropped once reads filled 64.
 */
function materializeTools(picked: DiscoveredTool[]): { tools: ToolDefinition[]; bindings: Map<string, ToolBinding> } {
  const tools: ToolDefinition[] = []
  const bindings = new Map<string, ToolBinding>()
  for (const d of picked) {
    bindings.set(d.name, d.binding)
    tools.push({ name: d.name, description: d.description, inputSchema: d.inputSchema })
  }
  return { tools, bindings }
}

export function capDiscoveredTools(discovered: DiscoveredTool[], organizationId: string): { tools: ToolDefinition[]; bindings: Map<string, ToolBinding> } {
  const seen = new Set<string>()
  const dedupe = (list: DiscoveredTool[]) => list.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)))
  const writes = dedupe(discovered.filter((d) => d.isWrite))
  const reads = dedupe(discovered.filter((d) => !d.isWrite))

  const picked: DiscoveredTool[] = [...writes.slice(0, WRITE_RESERVE)]
  for (const d of reads) { if (picked.length >= TOOL_CAP) break; picked.push(d) }
  for (const d of writes.slice(WRITE_RESERVE)) { if (picked.length >= TOOL_CAP) break; picked.push(d) }

  const dropped = writes.length + reads.length - picked.length
  if (dropped > 0) {
    apiLogger.warn('loadTools: tool cap reached; some discovered tools not exposed', {
      organizationId, discovered: writes.length + reads.length, cap: TOOL_CAP, dropped, writesKept: Math.min(writes.length, picked.filter((p) => p.isWrite).length),
    })
  }

  return materializeTools(picked)
}

/**
 * Choose which discovered tools to expose when there are more than the cap.
 *
 * Over the cap, the deterministic policy (capDiscoveredTools) fills reads in
 * arbitrary discovery order — so a large connector can crowd out the handful of
 * tools this agent actually needs. Instead, rank the over-budget tools by
 * embedding similarity to the agent's objective and keep the most relevant.
 * Write tools keep their reserved slice (consequential; never relevance-dropped)
 * and overflow writes compete on relevance like reads.
 *
 * Best-effort: under the cap, without a query, without embeddings configured, or
 * on any embedding failure, it falls back to the deterministic cap so tool
 * loading never depends on the embeddings provider being up.
 */
export async function selectDiscoveredTools(
  discovered: DiscoveredTool[],
  organizationId: string,
  query?: string,
): Promise<{ tools: ToolDefinition[]; bindings: Map<string, ToolBinding> }> {
  const seen = new Set<string>()
  const unique = discovered.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)))

  if (unique.length <= TOOL_CAP || !query?.trim() || !embeddingsConfigured()) {
    return capDiscoveredTools(discovered, organizationId)
  }

  try {
    const writes = unique.filter((d) => d.isWrite)
    const reads = unique.filter((d) => !d.isWrite)
    const keptWrites = writes.slice(0, WRITE_RESERVE)
    const budget = Math.max(0, TOOL_CAP - keptWrites.length)
    const candidates = [...reads, ...writes.slice(WRITE_RESERVE)]

    const [queryVec, docVecs] = await Promise.all([
      embedQuery(query.slice(0, 2000)),
      embedTexts(candidates.map((d) => `${d.name}: ${d.description}`.slice(0, 2000)), { inputType: 'document' }),
    ])
    const ranked = candidates
      .map((d, i) => ({ d, score: cosineSimilarity(queryVec, docVecs[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, budget)
      .map((r) => r.d)

    const picked = [...keptWrites, ...ranked]
    apiLogger.info('loadTools: selected tools by relevance to the objective', {
      organizationId, discovered: unique.length, cap: TOOL_CAP, kept: picked.length, dropped: unique.length - picked.length,
    })
    return materializeTools(picked)
  } catch (error) {
    apiLogger.warn('loadTools: relevance selection failed, using deterministic cap', {
      organizationId, error: error instanceof Error ? error.message : String(error),
    })
    return capDiscoveredTools(discovered, organizationId)
  }
}

async function loadTools(organizationId: string, providers: string[], ownerUserId?: string | null, query?: string) {
  // Every plane contributes to one list; the cap/priority policy is applied once
  // at the end (capDiscoveredTools) so write tools aren't crowded out. Plane
  // discovery/binding lives in ./tool-planes, shared with the flow tool catalog
  // and the flow tool-step executor.
  const discovered: DiscoveredTool[] = []
  const pushGroup = (group: ToolPlaneGroup, options: { cap?: number; namePrefix?: string } = {}) => {
    if (!group.client) return
    const prefix = options.namePrefix ?? group.provider
    const tools = options.cap ? group.tools.slice(0, options.cap) : group.tools
    for (const tool of tools) {
      discovered.push({
        name: toolName(prefix, tool.name),
        description: tool.description,
        inputSchema: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
        binding: { provider: group.provider, serverUrl: group.serverUrl, toolName: tool.name, client: group.client },
        isWrite: group.isWrite,
      })
    }
  }

  // ---- Klavis-managed MCP servers ----------------------------------------
  const klavisProviders = providers

  if (process.env.KLAVIS_API_KEY && klavisProviders.length > 0) {
    const klavisGroups = await loadKlavisPlaneGroups(organizationId, {
      agentTypes: klavisProviders.map((provider) => provider.toUpperCase()),
    })
    for (const group of klavisGroups) {
      if (group.tools.length > 20) {
        apiLogger.warn('loadTools: per-provider tool cap reached; some tools not exposed to the agent', {
          provider: group.provider, organizationId, discovered: group.tools.length, cap: 20, dropped: group.tools.length - 20,
        })
      }
      pushGroup(group, { cap: 20 })
    }
  }

  // ---- Per-org MCP connections (all active connections, any authType) ------
  // Custom MCP connections load for every agent regardless of the providers
  // list — EXCEPT Klavis Strata, which is opt-in per agent: its ~90 tools would
  // otherwise all be live at once. An agent gets Strata's meta-tools only when
  // it has selected at least one `strata:<server>`; the selected set scopes it
  // (see the system-prompt note added in the run). A failing/unreachable server
  // must NOT abort the run or block others.
  const strataSelected = selectedStrataServers(providers)
  const mcpGroups = await loadMcpConnectionPlaneGroups(organizationId, ownerUserId, {
    includeStrata: strataSelected.length > 0,
  })
  for (const group of mcpGroups) pushGroup(group, { cap: 20 })

  // ---- Native built-ins (Granola / Slack / HTTP / Email) --------------------
  // Each gated on its availability AND a matching providers entry.
  for (const group of await loadNativePlaneGroups(organizationId, { providers })) pushGroup(group)

  // ---- Nango delivery (outbound writes as the acting user) -----------------
  // Slack/Gmail/Salesforce writes through the org's Nango connections,
  // preferring the agent owner's own connection so messages arrive as the rep.
  // Gated per capability on both a matching providers entry and a resolvable
  // connection. Failures never abort the run.
  for (const group of await loadNangoPlaneGroups(organizationId, ownerUserId, { providers })) {
    pushGroup(group, { namePrefix: 'nango' })
  }

  // Select which tools to expose: over the cap, rank by relevance to the
  // objective (best-effort, embeddings-gated) with a reserved write budget;
  // otherwise the deterministic cap. Delivery tools aren't crowded out either way.
  return selectDiscoveredTools(discovered, organizationId, query)
}

async function recordEvent(executionId: string, stepId: string | null, kind: string, payload?: unknown) {
  await prisma.workflowEvent.create({
    data: { executionId, stepId, kind, payload: jsonValue(payload) },
  })
}

/** Condense the IR transcript into a short tool/step log for reflection. */
function transcriptSummaryForReflection(transcript: unknown): string {
  try {
    const messages = Array.isArray(transcript) ? transcript : []
    const lines: string[] = []
    for (const message of messages as { role?: string; text?: string; toolCalls?: { name?: string }[] }[]) {
      if (Array.isArray(message.toolCalls)) {
        for (const call of message.toolCalls) if (call?.name) lines.push(`tool: ${call.name}`)
      }
      if (message.role === 'assistant' && typeof message.text === 'string' && message.text.trim()) {
        lines.push(`assistant: ${message.text.slice(0, 200)}`)
      }
    }
    return lines.slice(-60).join('\n')
  } catch {
    return ''
  }
}

/**
 * Resume a suspended run (ask_user reply or approval decision) — inline in dev,
 * enqueued on the worker in prod. Shared by the reply route and the approval
 * decision route.
 */
export async function resumeAgentExecution(params: {
  executionId: string
  agentId: string
  organizationId: string
  userId: string
  reply: string
}): Promise<void> {
  if (inlineExecution) {
    await runAgentExecution({ ...params, resume: true })
    return
  }
  if (!workersEnabled) throw new Error('Agent worker is disabled')
  const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
  await queue.add('resume-agent', { ...params, resume: true }, { jobId: `${params.executionId}-resume-${Date.now()}` })
}

export async function runAgentExecution(
  // Inline callers (e.g. the flow runtime) may pass onExecutionCreated to learn
  // the execution id as soon as its row exists — long before the run finishes —
  // so live UIs can start following the run. It is intentionally NOT part of
  // AgentExecutionJob: queue jobs are serialized and can't carry a function.
  data: AgentExecutionJob & { onExecutionCreated?: (executionId: string) => void | Promise<void> },
) {
  const { agentId, organizationId, userId } = data
  const agent = await prisma.agentTask.findFirst({
    where: { id: agentId, organizationId, status: 'ACTIVE' },
  })
  if (!agent) throw new Error('Agent not found or inactive')

  const agentMetadata = metadataOf(agent.metadata)
  // Structured-output contract (same as flow agent steps): an agent whose
  // metadata declares outputFields + responseFormat 'structured' must reply
  // with JSON carrying those properties. Prompt side below; validation at the
  // final-output settle. (Config UI is a follow-up — metadata is the surface.)
  const structuredFields: OutputField[] =
    agentMetadata.responseFormat === 'structured' && Array.isArray(agentMetadata.outputFields)
      ? (agentMetadata.outputFields as OutputField[]).filter((field) => typeof field?.name === 'string' && field.name.trim())
      : []
  const model = agentMetadata.model || DEFAULT_AGENT_MODEL
  const runner = createModelRunner(model)

  const queuedExecution = data.executionId
    ? await prisma.agentExecution.findFirst({
        where: {
          id: data.executionId,
          agentTaskId: agentId,
          organizationId,
        },
      })
    : null
  if (data.executionId && !queuedExecution) throw new Error('Queued execution does not match this tenant and agent')

  const resuming = Boolean(data.resume)
  if (resuming && !queuedExecution) throw new Error('Resume requested without an execution')

  // A re-delivered execution: skip terminal/waiting ones, but RESUME a run that
  // was interrupted mid-flight (status 'running' with a checkpointed transcript)
  // from its last completed turn instead of restarting from the top and
  // re-firing every side effect.
  let resumeFromCrash = false
  if (queuedExecution && !resuming && queuedExecution.status !== 'pending') {
    if (queuedExecution.status === 'running' && Array.isArray(queuedExecution.transcript)) {
      resumeFromCrash = true
    } else {
      return { status: queuedExecution.status, skipped: true as const }
    }
  }

  let transcript: unknown[]
  let pendingResults: ToolResult[] | null = null
  let startTurn = 0
  // On any resume, already-succeeded tool steps form an idempotency ledger so a
  // replayed call reuses its stored output instead of re-firing.
  let completedToolSteps = new Map<string, unknown>()

  if (resuming && queuedExecution) {
    const executionMetadata = metadataOf(queuedExecution.metadata)
    const pending = executionMetadata.pendingQuestion as PendingQuestion | undefined
    const waiting = queuedExecution.status === 'waiting_for_input' || queuedExecution.status === 'waiting_for_approval'
    if (!waiting || !pending || !Array.isArray(queuedExecution.transcript)) {
      throw new Error('Execution is not waiting for input or approval')
    }
    // Atomic claim (same pattern as approval decide): two concurrent replies —
    // e.g. builder and Activity page both open — must not both resume. Exactly
    // one caller flips waiting_* -> running; the loser errors cleanly here.
    // systemPrisma: id-keyed terminal write on worker job data; execution id was
    // validated against this tenant when queuedExecution was loaded above.
    const claimed = await systemPrisma.agentExecution.updateMany({
      where: { id: queuedExecution.id, status: { in: ['waiting_for_input', 'waiting_for_approval'] } },
      data: { status: 'running' },
    })
    if (claimed.count === 0) {
      throw new Error('Execution is not waiting for input or approval')
    }
    // Normalize to the provider-neutral IR so a run persisted in a native shape
    // (pre-IR, or by the other provider) resumes on whatever provider routes now.
    transcript = coerceToIR(queuedExecution.transcript as unknown[])
    startTurn = Number(executionMetadata.turnCursor) || 0
    completedToolSteps = await loadCompletedToolSteps(queuedExecution.id)
    const reply = data.reply?.trim() || 'The user did not provide an answer. Use your best judgment.'
    pendingResults = [
      ...(pending.collectedResults || []),
      { toolCallId: pending.toolCallId, content: reply },
    ]
    if (pending.stepId) {
      await prisma.workflowStep.update({
        where: { id: pending.stepId },
        data: { status: 'succeeded', output: jsonValue({ answer: reply }), completedAt: new Date() },
      })
    }
    await recordEvent(queuedExecution.id, pending.stepId || null, 'user.replied', { answer: reply })
    // Input memory (WS1.9): remember the Q/A so future runs stop re-asking.
    void saveAgentMemory({
      organizationId,
      agentId,
      kind: 'user_answer',
      title: pending.question.slice(0, 120),
      content: reply,
      question: pending.question,
      sourceExecutionId: queuedExecution.id,
    })
  } else if (resumeFromCrash && queuedExecution) {
    transcript = coerceToIR(queuedExecution.transcript as unknown[])
    startTurn = Number(metadataOf(queuedExecution.metadata).turnCursor) || 0
    completedToolSteps = await loadCompletedToolSteps(queuedExecution.id)
    await recordEvent(queuedExecution.id, null, 'run.resumed', { fromTurn: startTurn })
  } else {
    transcript = runner.start(data.input || agent.objective)
  }

  const execution = queuedExecution
    ? // systemPrisma: id-keyed terminal write on worker job data; execution id was
      // validated against this tenant when queuedExecution was loaded above.
      await systemPrisma.agentExecution.update({
        where: { id: queuedExecution.id },
        data: {
          status: 'running',
          model: runner.model,
          ...(resuming
            ? { metadata: jsonValue({ ...metadataOf(queuedExecution.metadata), pendingQuestion: null }) }
            : { startedAt: new Date() }),
        },
      })
    : await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'running',
          model: runner.model,
          input: { prompt: data.input || agent.objective },
          trigger: { type: 'schedule' },
          metadata: { title: agentMetadata.title || agent.description },
          userId,
          organizationId,
        },
      })

  // The execution row now exists: hand its id to the caller. Fire-and-forget
  // and fully fenced — a callback failure (sync or async) must never fail or
  // delay the run itself.
  if (data.onExecutionCreated) {
    try {
      void Promise.resolve(data.onExecutionCreated(execution.id)).catch(() => undefined)
    } catch {
      // Best-effort notification only.
    }
  }

  if (!resuming) {
    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'user', content: data.input || agent.objective },
    })
  }

  const executionMetadata = metadataOf(execution.metadata)
  const segmentStart = Date.now()
  const usage = { inputTokens: 0, outputTokens: 0 }

  // Single graceful cancel-finalize path, shared by the in-loop per-turn check
  // AND the completion/failure guards below. A cancel request only ever flips
  // status to 'cancelling' (never mutates this in-memory run), so whichever
  // call site notices it first does the actual persistence; `alreadyFinalized`
  // lets a later call site (e.g. the failure guard, after the completion
  // guard already persisted 'cancelled' but then threw) skip re-recording the
  // event/notification while still returning the cancelled summary instead of
  // falling through to complete/fail. No reflection/indexing runs for a
  // cancelled run — those are for runs that actually produced an outcome
  // worth learning from.
  const finalizeCancelled = async (alreadyFinalized: boolean) => {
    const cancelSummary = 'Run cancelled by the user.'
    if (!alreadyFinalized) {
      await prisma.executionMessage.create({
        data: { executionId: execution.id, role: 'agent', content: cancelSummary },
      })
      // systemPrisma: id-keyed terminal write on worker job data; execution id was
      // validated against this tenant when execution was loaded/created above.
      await systemPrisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'cancelled',
          error: null,
          transcript: jsonValue(transcript),
          inputTokens: { increment: usage.inputTokens },
          outputTokens: { increment: usage.outputTokens },
          executionTime: { increment: Date.now() - segmentStart },
          completedAt: new Date(),
        },
      })
      await recordEvent(execution.id, null, 'run.cancelled', { reason: 'user_requested' })
      await notify({
        organizationId,
        userId,
        type: 'agent.cancelled',
        level: 'info',
        title: `${agentMetadata.title || agent.description} run cancelled`,
        body: cancelSummary,
        agentTaskId: agent.id,
        executionId: execution.id,
      })
    }
    return { summary: cancelSummary, executionId: execution.id }
  }

  try {
    // Enforce the workspace's monthly token ceiling before doing any model work.
    // The run's owner is passed so exempt admin accounts are never blocked.
    const budget = await checkMonthlyTokenBudget(organizationId, userId)
    if (budget.over) {
      throw new Error(
        `Monthly token budget reached for this workspace (${budget.used.toLocaleString()}/${budget.limit.toLocaleString()} tokens). Raise AGENT_MONTHLY_TOKEN_LIMIT or wait for the next cycle.`,
      )
    }

    // Typed connector bindings gate tool loading; falls back to
    // metadata.integrations for agents created before the FK existed.
    const providers = await resolveAgentConnectorKeys(agent.id, agentMetadata)
    const skillIds = Array.isArray(agentMetadata.skills) ? agentMetadata.skills.map(String) : []
    const toolQuery = [agent.objective, data.input].filter(Boolean).join('\n')
    const { tools, bindings } = await loadTools(organizationId, providers, userId, toolQuery)
    // Community skills are public-library rows; resolve any attached ids that
    // aren't built in and compose them the same way. Best-effort.
    // systemPrisma: public community skill library — cross-org by design, same
    // as GET /api/skills (any org may compose any published community skill).
    const communitySkills = skillIds.length
      ? await systemPrisma.sharedSkill
          .findMany({ where: { id: { in: skillIds }, isActive: true }, select: { id: true, name: true, instructions: true } })
          .catch(() => [])
      : []
    let system = buildAgentSystemPrompt(agent.objective, skillIds, communitySkills)
    if (structuredFields.length) {
      system += `\n\n${structuredResponseInstruction(structuredFields)}`
    }

    // Scope Klavis Strata to the servers this agent selected, so its discovery/
    // execute meta-tools only reach the intended tools rather than all ~90.
    const strataScope = selectedStrataServers(providers)
    if (strataScope.length) {
      system += `\nThrough the Klavis Strata meta-tools, use ONLY these servers: ${strataScope.join(', ')}. When calling the discovery and execute_action tools, restrict server_names to this list and do not use other Strata servers.`
    }

    // Goal awareness + strategize mode (WS1.9). The goal steers every turn;
    // complex tasks are told to plan before acting.
    const goalBlock = goalSection((agent as { goal?: string | null }).goal)
    if (goalBlock) system += `\n\n${goalBlock}`
    const strategize = shouldStrategize({ objective: agent.objective, metadata: agentMetadata, toolCount: tools.length })
    if (strategize) system += `\n\n${strategizeSection()}`

    // Multi-agent handoff: an opted-in agent can delegate to other agents via a
    // run_agent tool (fan-out over a set, or sequential pipeline stages). Bounded
    // by depth, a per-run count cap, and a cycle guard; sub-runs share the org's
    // token budget. Only offered to top-level/mid-chain runs under the depth cap.
    const depth = data.depth ?? 0
    const chain = [...(data.ancestorAgentIds ?? []), agent.id]
    if (agentMetadata.allowSubagents === true && depth < MAX_SUBAGENT_DEPTH) {
      // A non-empty subagentIds allow-list restricts the roster; empty = any
      // visible agent (the default).
      const allowList = (Array.isArray(agentMetadata.subagentIds) ? agentMetadata.subagentIds : []).filter(
        (id): id is string => typeof id === 'string',
      )
      const callable = await prisma.agentTask.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          id: allowList.length ? { in: allowList, notIn: chain } : { notIn: chain },
          ...agentVisibilityScope(userId),
        },
        select: { id: true, description: true, metadata: true },
        take: 100,
      })
      const nameOf = (m: unknown) => (metadataOf(m).title as string) || ''
      const roster = callable
        .map((a) => `- "${nameOf(a.metadata) || a.description}"`)
        .join('\n')
      const runAgentTool: ToolDefinition = {
        name: 'run_agent',
        description:
          'Delegate a sub-task to another agent and get its result back. Use this to run a worker agent once per item (fan-out) or to chain a pipeline stage. ' +
          `You can call it up to ${MAX_SUBAGENTS_PER_RUN} times this run. Available agents:\n${roster || '(none)'}`,
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'The exact name of the agent to run (from the list above).' },
            input: { type: 'string', description: 'The task/input to give that agent (e.g. the account to score).' },
          },
          required: ['agent', 'input'],
        },
      }
      let subRunCount = 0
      const runAgentClient: McpToolClient = {
        executeTool: async (_serverUrl, _name, args) => {
          const wanted = String((args as Record<string, unknown>).agent || '').trim()
          const subInput = String((args as Record<string, unknown>).input || '').trim()
          if (!wanted) return { error: 'Provide the name of the agent to run.' }
          if (subRunCount >= MAX_SUBAGENTS_PER_RUN) {
            return { error: `Sub-agent limit reached (${MAX_SUBAGENTS_PER_RUN} per run). Summarize what you have instead of running more.` }
          }
          const target = callable.find(
            (a) => a.id === wanted || nameOf(a.metadata).toLowerCase() === wanted.toLowerCase() || a.description.toLowerCase() === wanted.toLowerCase(),
          )
          if (!target) return { error: `No agent named "${wanted}" is available to run.` }
          if (chain.includes(target.id)) return { error: `"${wanted}" is already running upstream — cycles are not allowed.` }
          subRunCount += 1
          try {
            const result = await runAgentExecution({
              agentId: target.id,
              organizationId,
              userId,
              input: subInput,
              depth: depth + 1,
              ancestorAgentIds: chain,
            })
            // A completed sub-run returns { summary }; a suspended one (asked
            // the user / awaiting approval) returns { status: 'waiting_*' }.
            const sub = result as { summary?: string; status?: string; question?: string }
            if (typeof sub?.summary === 'string') return { agent: nameOf(target.metadata) || target.description, output: sub.summary }
            if (typeof sub?.status === 'string' && sub.status.startsWith('waiting')) {
              return { agent: wanted, note: `The sub-agent paused (${sub.status}${sub.question ? `: ${sub.question}` : ''}), which pipelines do not support. Make it self-sufficient or pass what it needs in the input.` }
            }
            return { agent: wanted, note: 'The sub-agent produced no output.' }
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }
        },
      }
      tools.push(runAgentTool)
      bindings.set('run_agent', { provider: 'agent', serverUrl: '', toolName: 'run_agent', client: runAgentClient })
    }

    // Unified retrieved-context budget: the three systems below (graph-RAG →
    // knowledge → memory, in that priority order) share one character budget
    // and a cross-system dedupe, so no single source floods the prompt and the
    // same fact never arrives twice via different systems.
    const contextAssembler = createContextAssembler()

    // Graph-RAG: give the agent correlated context (Sales AI signals,
    // integration/MCP data from prior runs, related accounts/opps) before it
    // acts. Best-effort and gated — a no-op when embeddings aren't configured.
    try {
      const execInput = (queuedExecution?.input ?? null) as { signal?: { accountId?: string; opportunityId?: string } } | null
      const signalRef = execInput?.signal
      const seedNodeIds = [
        `agent:${agent.id}`,
        signalRef?.accountId ? `account:${signalRef.accountId}` : null,
        signalRef?.opportunityId ? `opp:${signalRef.opportunityId}` : null,
      ].filter((id): id is string => Boolean(id))
      const ragContext = await retrieveContext(getGraphRagStore(), {
        organizationId,
        // Scope correlated context to this rep: shared org data + their own
        // private nodes, never another rep's private book.
        viewerUserId: userId,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
        seedNodeIds,
        ...(strategize ? { topK: STRATEGIZE_RETRIEVAL.topK, hops: STRATEGIZE_RETRIEVAL.hops } : {}),
      })
      const budgeted = {
        hits: contextAssembler.take(ragContext.hits, (h) => h.text, (h) => h.score),
        related: contextAssembler.take(ragContext.related, (r) => r.text, () => undefined),
      }
      const rendered = renderContext(budgeted)
      if (rendered) {
        system = `${system}\n\n${rendered}`
        // Surface the correlated context in the run's activity log so the
        // "brain" is visible: what Sales AI signals / prior runs / related
        // accounts the agent pulled in before acting.
        await recordEvent(execution.id, null, 'context.retrieved', {
          source: 'graph-rag',
          hits: budgeted.hits.map((h) => ({ type: h.type, text: h.text })),
          related: budgeted.related.map((r) => ({ type: r.type, text: r.text })),
          summary: `Pulled ${budgeted.hits.length} correlated fact(s) + ${budgeted.related.length} connected entit(ies) from Sales AI, integrations, and prior runs.`,
        })
      }
    } catch (error) {
      apiLogger.warn('execute-agent: RAG context skipped', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Uploaded file knowledge: retrieve the most relevant chunks for this agent
    // and inject them into the system prompt. Best-effort — never blocks a run.
    try {
      const knowledgeHits = await retrieveKnowledge({
        organizationId,
        agentId: agent.id,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
      })
      const budgetedKnowledge = contextAssembler.take(knowledgeHits, (h) => h.content, (h) => h.score)
      const knowledgeBlock = renderKnowledge(budgetedKnowledge)
      if (knowledgeBlock) {
        system = `${system}\n\n${knowledgeBlock}`
        await recordEvent(execution.id, null, 'knowledge.retrieved', {
          source: 'uploaded-files',
          files: [...new Set(budgetedKnowledge.map((h) => h.filename))],
          summary: `Pulled ${budgetedKnowledge.length} passage(s) from ${new Set(budgetedKnowledge.map((h) => h.filename)).size} uploaded file(s).`,
        })
      }
    } catch (error) {
      apiLogger.warn('execute-agent: knowledge retrieval skipped', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Agent memory: remembered answers, learnings, and the latest self-critique
    // from prior runs. Best-effort — never blocks a run.
    try {
      // Widen the search over the hidden org-intelligence holder's *learnings*
      // (distilled from connection scans across the whole org — see
      // scanConnection) so every agent's runs benefit, not just graph-RAG
      // callers. Read-only lookup: an org that never scanned anything has no
      // holder, and must not get one conjured into existence by a run's mere
      // memory retrieval — use findOrgIntelligenceAgentId (never the
      // get-or-create orgIntelligenceAgentId) here.
      const orgMemoryAgentId = await findOrgIntelligenceAgentId(organizationId)
      const memoryHits = await retrieveAgentMemory({
        organizationId,
        agentId: agent.id,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
        extraAgentIds: orgMemoryAgentId ? [orgMemoryAgentId] : undefined,
      })
      const critique = typeof agentMetadata.lastCritique === 'string' ? agentMetadata.lastCritique : null
      const budgetedMemories = contextAssembler.take(memoryHits, (h) => `${h.title}\n${h.content}`, (h) => h.score)
      const memoryBlock = renderAgentMemories(budgetedMemories, critique)
      if (memoryBlock) {
        system = `${system}\n\n${memoryBlock}`
        void markMemoriesUsed(budgetedMemories.map((h) => h.id))
        await recordEvent(execution.id, null, 'memory.retrieved', {
          source: 'agent-memory',
          count: budgetedMemories.length,
          summary: `Recalled ${budgetedMemories.length} memor${budgetedMemories.length === 1 ? 'y' : 'ies'} from previous runs${critique ? ' + a note-to-self' : ''}.`,
        })
      }
    } catch (error) {
      apiLogger.warn('execute-agent: memory retrieval skipped', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (pendingResults) runner.appendToolResults(transcript, pendingResults)

    const maxTurns = Number(agentMetadata.maxTurns) || Number(process.env.AGENT_MAX_TURNS) || 16
    // Per-run token backstop against a pathological loop (independent of the
    // monthly ceiling). Generous by default; tune via AGENT_MAX_RUN_TOKENS.
    const perRunTokenCap = Number(process.env.AGENT_MAX_RUN_TOKENS) || 2_000_000
    const monthlyLimit = budget.limit
    let finalText = ''
    let planEmitted = false

    for (let turn = startTurn; turn < maxTurns; turn += 1) {
      // Cooperative cancellation: the cancel API flips a running execution's
      // status to 'cancelling' rather than mutating this in-memory loop, so
      // check the freshest DB status once per turn (an extra findUnique per
      // LLM call is cheap) and exit cleanly the moment it's noticed.
      // systemPrisma: cancellation poll — id-keyed read on worker job data;
      // execution id was validated against this tenant when it was loaded/created above.
      const live = await systemPrisma.agentExecution.findUnique({ where: { id: execution.id }, select: { status: true } })
      if (live?.status === 'cancelling' || live?.status === 'cancelled') {
        return await finalizeCancelled(live.status === 'cancelled')
      }

      const turnResult = await runner.next(transcript, system, [...tools, ASK_USER_TOOL])
      usage.inputTokens += turnResult.usage.inputTokens
      usage.outputTokens += turnResult.usage.outputTokens

      // Record this turn's spend on the live cross-process counter, then enforce
      // both the per-run cap and the (in-flight-aware) monthly ceiling mid-run so
      // a runaway can't blow far past the budget between the start-of-run check
      // and completion.
      const runTotal = usage.inputTokens + usage.outputTokens
      const monthTotal = await recordTokenUsage(organizationId, turnResult.usage.inputTokens + turnResult.usage.outputTokens)
      if (perRunTokenCap > 0 && runTotal >= perRunTokenCap) {
        finalText = turnResult.text || 'Run stopped: it reached its per-run token cap.'
        await recordEvent(execution.id, null, 'run.capped', { reason: 'per_run_token_cap', runTotal, cap: perRunTokenCap })
        break
      }
      if (monthlyLimit > 0 && (monthTotal ?? 0) >= monthlyLimit) {
        finalText = turnResult.text || 'Run stopped: the workspace monthly token budget was reached.'
        await recordEvent(execution.id, null, 'run.capped', { reason: 'monthly_budget', monthTotal, limit: monthlyLimit })
        break
      }

      if (!turnResult.toolCalls.length) {
        finalText = turnResult.text || 'Agent completed without a text response.'
        break
      }

      // Capture the assistant's narration that accompanies a tool-calling turn so
      // the activity log can show the agent's reasoning as it works, interleaved
      // with the tool calls it makes.
      if (turnResult.text && turnResult.text.trim()) {
        const thinkingKind = strategize && !planEmitted ? 'agent.plan' : 'agent.thinking'
        if (thinkingKind === 'agent.plan') planEmitted = true
        await recordEvent(execution.id, null, thinkingKind, { text: turnResult.text.trim() })
      }

      const results: ToolResult[] = []
      let pendingAsk: { toolCallId: string; question: string } | null = null
      let pendingApproval: { toolCallId: string; approvalId: string; stepId: string; summary: string } | null = null

      for (const call of turnResult.toolCalls) {
        if (call.name === ASK_USER_TOOL.name) {
          // At most ONE suspension per turn (a question OR an approval). A run
          // suspends by leaving exactly one tool_use id unresolved (it becomes
          // pendingQuestion.toolCallId, resolved on resume); a second unresolved
          // id would orphan a tool call and make the persisted transcript
          // unreplayable. So any further ask/approval gets a covering result.
          if (pendingAsk || pendingApproval) {
            results.push({
              toolCallId: call.id,
              content: JSON.stringify({ error: 'You can only pause once per turn (a question or an approval is already pending). Ask again after it resolves.' }),
              isError: true,
            })
            continue
          }
          pendingAsk = {
            toolCallId: call.id,
            question: String(call.input.question || 'The agent needs your input to continue.'),
          }
          continue
        }

        const binding = bindings.get(call.name)
        const step = await prisma.workflowStep.create({
          data: {
            executionId: execution.id,
            node: binding ? `${binding.provider}.${binding.toolName}` : call.name,
            status: 'running',
            input: jsonValue(call.input),
            startedAt: new Date(),
          },
        })
        await recordEvent(execution.id, step.id, 'tool.started', { name: step.node, args: call.input })

        try {
          if (!binding) throw new Error(`Tool binding not found: ${call.name}`)

          // Durable replay: if this exact call already succeeded in a prior
          // attempt of this run (crash/retry), reuse its stored output instead
          // of re-executing and re-firing side effects.
          const replayKey = toolStepKey(step.node, call.input)
          if (completedToolSteps.has(replayKey)) {
            const cached = completedToolSteps.get(replayKey)
            await prisma.workflowStep.update({
              where: { id: step.id },
              data: { status: 'succeeded', output: jsonValue(cached), completedAt: new Date() },
            })
            await recordEvent(execution.id, step.id, 'tool.replayed', { name: step.node })
            results.push({ toolCallId: call.id, content: JSON.stringify(cached) })
            continue
          }

          // Approval gate: if this agent requires approval and the tool is an
          // outbound write, queue it instead of executing — an approver runs
          // it out-of-band, and the RUN SUSPENDS until the decision. On approve,
          // decideApproval executes the write and resumes this run with its
          // result injected, so the agent acts on the real outcome (rather than
          // continuing blind on a "queued" placeholder).
          if (requiresApproval(agentMetadata, binding.provider)) {
            // Only ONE suspension per turn: if a question or another approval is
            // already pending, defer this one with a covering result (and do NOT
            // create an approval row, so nothing is orphaned) — the model
            // re-proposes it once the run resumes.
            if (pendingApproval || pendingAsk) {
              await prisma.workflowStep.update({
                where: { id: step.id },
                data: { status: 'succeeded', output: jsonValue({ deferred: true }), completedAt: new Date() },
              })
              results.push({
                toolCallId: call.id,
                content: JSON.stringify({ status: 'deferred', message: 'Another action is already pending this turn; re-propose this once it resolves.' }),
              })
              continue
            }
            const approval = await createApproval({
              organizationId,
              executionId: execution.id,
              userId,
              provider: binding.provider,
              tool: call.name,
              args: (call.input ?? {}) as Record<string, unknown>,
            })
            await prisma.workflowStep.update({
              where: { id: step.id },
              data: { status: 'waiting', output: jsonValue({ approvalId: approval.id }) },
            })
            await recordEvent(execution.id, step.id, 'tool.queued_for_approval', { name: step.node, approvalId: approval.id })
            pendingApproval = { toolCallId: call.id, approvalId: approval.id, stepId: step.id, summary: step.node }
            continue
          }

          const result = await binding.client.executeTool(binding.serverUrl, binding.toolName, call.input)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'succeeded', output: jsonValue(result), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.completed', { name: step.node })
          // Immutable audit trail. Delivery/write planes (nango, slack, email,
          // salesforce) are the consequential ones; the args are
          // hashed, not stored.
          const writePlanes = /^(nango|slack|email)/i
          await recordAudit({
            organizationId,
            executionId: execution.id,
            actorUserId: userId,
            actorKind: 'agent',
            action: writePlanes.test(binding.provider) ? 'tool.write' : 'tool.call',
            tool: call.name,
            resourceType: binding.provider,
            payload: call.input,
          })
          results.push({ toolCallId: call.id, content: JSON.stringify(result) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'failed', error: jsonValue({ message }), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.failed', { name: step.node, error: message })
          results.push({ toolCallId: call.id, content: JSON.stringify({ error: message }), isError: true })
        }
      }

      // Remembered-answer match (WS1.9): auto-answer when the per-agent toggle
      // is on and confidence is high; otherwise attach the best previous
      // answer so the UI can prefill it. Computed before the waiting step is
      // created so an auto-answer can resolve the pause without ever
      // persisting a waiting_for_input state.
      let suggestedAnswer: { memoryId: string; content: string; score: number } | null = null
      if (pendingAsk) {
        try {
          const remembered = await prisma.agentMemory.findMany({
            where: { organizationId, agentId: agent.id, kind: 'user_answer', status: 'open' },
            select: { id: true, question: true, content: true, embedding: true },
            orderBy: { createdAt: 'desc' },
            take: 100,
          })
          if (remembered.length) {
            let questionVec: number[] | null = null
            if (embeddingsConfigured()) {
              questionVec = await embedQuery(pendingAsk.question.slice(0, 2000)).catch(() => null)
            }
            const match = bestAnswerMatch(questionVec, pendingAsk.question, remembered)
            if (match) suggestedAnswer = { memoryId: match.id, content: match.content, score: match.score }
          }
        } catch {
          /* best-effort */
        }

        if (suggestedAnswer && agentMetadata.autoAnswerFromMemory === true) {
          await recordEvent(execution.id, null, 'agent.question.autoanswered', {
            question: pendingAsk.question,
            answer: suggestedAnswer.content,
            memoryId: suggestedAnswer.memoryId,
            score: suggestedAnswer.score,
          })
          void markMemoriesUsed([suggestedAnswer.memoryId])
          // Mirror how a normal tool result is appended for this turn (pushed
          // into `results`, not appended directly) so it rides along with any
          // other tool calls made this same turn and the loop proceeds exactly
          // as it would after any other resolved tool call.
          results.push({ toolCallId: pendingAsk.toolCallId, content: suggestedAnswer.content })
          pendingAsk = null
        }
      }

      if (pendingAsk) {
        const step = await prisma.workflowStep.create({
          data: {
            executionId: execution.id,
            node: 'ask_user',
            status: 'waiting',
            input: jsonValue({ question: pendingAsk.question }),
            startedAt: new Date(),
          },
        })
        await recordEvent(execution.id, step.id, 'agent.question', {
          question: pendingAsk.question,
          ...(suggestedAnswer ? { suggestedAnswer: { content: suggestedAnswer.content, memoryId: suggestedAnswer.memoryId } } : {}),
        })
        await prisma.executionMessage.create({
          data: { executionId: execution.id, role: 'agent', content: pendingAsk.question },
        })
        // systemPrisma: id-keyed terminal write on worker job data; execution id was
        // validated against this tenant when execution was loaded/created above.
        await systemPrisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'waiting_for_input',
            transcript: jsonValue(transcript),
            inputTokens: { increment: usage.inputTokens },
            outputTokens: { increment: usage.outputTokens },
            executionTime: { increment: Date.now() - segmentStart },
            metadata: jsonValue({
              ...executionMetadata,
              // Resume continues at the next turn (the reply completes this one).
              turnCursor: turn + 1,
              pendingQuestion: {
                toolCallId: pendingAsk.toolCallId,
                question: pendingAsk.question,
                stepId: step.id,
                collectedResults: results,
              } satisfies PendingQuestion,
            }),
          },
        })
        await notify({
          organizationId,
          userId,
          type: 'agent.needs_input',
          level: 'action',
          title: `${agentMetadata.title || agent.description} needs your input`,
          body: pendingAsk.question,
          agentTaskId: agent.id,
          executionId: execution.id,
        })
        return { status: 'waiting_for_input', question: pendingAsk.question, executionId: execution.id }
      }

      // Suspend for approval: persist state (reusing the pendingQuestion marker,
      // so the existing resume path injects the approver's result) and return.
      // decideApproval runs the write and resumes this run with the result.
      if (pendingApproval) {
        // systemPrisma: id-keyed terminal write on worker job data; execution id was
        // validated against this tenant when execution was loaded/created above.
        await systemPrisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'waiting_for_approval',
            transcript: jsonValue(transcript),
            inputTokens: { increment: usage.inputTokens },
            outputTokens: { increment: usage.outputTokens },
            executionTime: { increment: Date.now() - segmentStart },
            metadata: jsonValue({
              ...executionMetadata,
              turnCursor: turn + 1,
              pendingQuestion: {
                toolCallId: pendingApproval.toolCallId,
                question: `Awaiting approval: ${pendingApproval.summary}`,
                stepId: pendingApproval.stepId,
                collectedResults: results,
              } satisfies PendingQuestion,
            }),
          },
        })
        await notify({
          organizationId,
          userId,
          type: 'agent.needs_approval',
          level: 'action',
          title: `${agentMetadata.title || agent.description} needs approval`,
          body: `Approve or reject: ${pendingApproval.summary}`,
          agentTaskId: agent.id,
          executionId: execution.id,
        })
        return { status: 'waiting_for_approval', approvalId: pendingApproval.approvalId, executionId: execution.id }
      }

      runner.appendToolResults(transcript, results)

      // Durable checkpoint at a clean turn boundary (results appended → the
      // stored transcript is a valid, resumable conversation). A crash/retry
      // after this resumes from turn+1 instead of losing prior turns.
      // systemPrisma: id-keyed terminal write on worker job data; execution id was
      // validated against this tenant when execution was loaded/created above.
      await systemPrisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          transcript: jsonValue(transcript),
          metadata: jsonValue({ ...executionMetadata, turnCursor: turn + 1 }),
        },
      })
    }

    // A cancel requested near this run's natural end can land after the
    // in-loop check above already passed for what turns out to be the final
    // turn (e.g. while the last runner.next() call was in flight, and that
    // turn broke the loop with no more tool calls). Re-check the live status
    // once more before treating this as a normal completion, so the user's
    // cancel wins the race instead of being silently overwritten — and so
    // indexing/reflection (below) never run for a run the user asked to stop.
    // systemPrisma: cancellation poll — id-keyed read on worker job data;
    // execution id was validated against this tenant when it was loaded/created above.
    const liveBeforeCompletion = await systemPrisma.agentExecution.findUnique({ where: { id: execution.id }, select: { status: true } })
    if (liveBeforeCompletion?.status === 'cancelling' || liveBeforeCompletion?.status === 'cancelled') {
      return await finalizeCancelled(liveBeforeCompletion.status === 'cancelled')
    }

    const summary = finalText || 'Agent reached the maximum number of tool-call turns.'
    let output: Record<string, unknown> = { summary }
    if (structuredFields.length) {
      const parsed = parseStructuredAgentOutput(finalText, structuredFields)
      if (parsed.output) {
        output = { summary, structured: parsed.output }
      } else {
        // Loud, but the text answer keeps its value: surface the contract
        // violation on the run instead of silently shipping unstructured text.
        output = { summary, structuredError: parsed.error }
        await recordEvent(execution.id, null, 'agent.structured_output_invalid', { error: parsed.error })
      }
    }
    const headline = await generateHeadline(summary)

    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'agent', content: summary },
    })
    // systemPrisma: id-keyed terminal writes on worker job data; execution/agent
    // ids were validated against this tenant when they were loaded/created above.
    await systemPrisma.$transaction([
      systemPrisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'completed',
          output: jsonValue(output),
          transcript: jsonValue(transcript),
          inputTokens: { increment: usage.inputTokens },
          outputTokens: { increment: usage.outputTokens },
          executionTime: { increment: Date.now() - segmentStart },
          completedAt: new Date(),
          metadata: jsonValue({ ...executionMetadata, pendingQuestion: null, ...(headline ? { headline } : {}) }),
        },
      }),
      systemPrisma.agentTask.update({
        where: { id: agent.id },
        data: {
          lastExecutedAt: new Date(),
          executionCount: { increment: 1 },
          lastResult: jsonValue(output),
        },
      }),
    ])
    await notify({
      organizationId,
      userId,
      type: 'agent.completed',
      level: 'success',
      title: `${agentMetadata.title || agent.description} completed`,
      body: headline || summary,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    // Index this run (output + correlated entities) into the graph-RAG store so
    // future agents/assistant answers can draw on what happened here. Fire and
    // forget — gated on embeddings, never blocks completion.
    void indexExecution({
      id: execution.id,
      organizationId,
      agentTaskId: agent.id,
      agentTitle: (agentMetadata.title as string) || agent.description,
      signalId: (queuedExecution?.input as { signal?: { id?: string } } | null)?.signal?.id ?? null,
      input: queuedExecution?.input ?? { prompt: data.input },
      output,
      status: 'completed',
      // Runs inherit the agent's scope: a private agent's runs stay private to
      // its owner, matching executionVisibilityScope for row-level access.
      ownerUserId: agent.userId ?? null,
      visibility: agent.visibility === 'private' ? 'private' : 'shared',
    }).catch(() => undefined)
    // Post-run reflection (WS1.9): distill learnings + critique + suggestions.
    // Chained before graph indexing enrichment is NOT needed — indexExecution
    // already ran; reflection memories are graph-indexed via their own path in
    // plan 2. Fire-and-forget: never blocks or fails the run.
    void reflectAndRemember({
      organizationId,
      agentId: agent.id,
      executionId: execution.id,
      goal: (agent as { goal?: string | null }).goal ?? null,
      objective: agent.objective,
      summary,
      processLog: transcriptSummaryForReflection(transcript),
      recordSuggestionEvent: (payload) => recordEvent(execution.id, null, 'agent.suggestion', payload),
      userId: agent.userId ?? userId,
      model,
      integrations: providers,
      category: typeof agentMetadata.category === 'string' ? agentMetadata.category : undefined,
      runSucceeded: true,
    }).catch(() => undefined)
    // Fire the agent.completed signal for flows listening in this org. Dynamic
    // import avoids pulling the flows feature (and its execute-flow ->
    // signals static edge) into every agent-execution module load; strictly
    // fire-and-forget — a signal emit must never block or fail this run.
    void import('@/features/flows/signals')
      .then((signals) =>
        signals.emitFlowSignal({
          organizationId,
          signal: 'agent.completed',
          payload: { agentId: agent.id, executionId: execution.id, summary: summary.slice(0, 2000) },
          depth: 1,
        }),
      )
      .catch(() => undefined)
    return { ...output, executionId: execution.id }
  } catch (error) {
    // A cancelled run that then throws (e.g. the completion guard above
    // finalized it as cancelled but a later step in this same try block still
    // threw) should finalize as cancelled, not failed — re-check the live
    // status before writing a failure over what may already be a cancel.
    // systemPrisma: cancellation poll — id-keyed read on worker job data;
    // execution id was validated against this tenant when it was loaded/created above.
    const liveOnFailure = await systemPrisma.agentExecution
      .findUnique({ where: { id: execution.id }, select: { status: true } })
      .catch(() => null)
    if (liveOnFailure?.status === 'cancelling' || liveOnFailure?.status === 'cancelled') {
      return await finalizeCancelled(liveOnFailure.status === 'cancelled')
    }

    const message = error instanceof Error ? error.message : String(error)
    // systemPrisma: id-keyed terminal write on worker job data; execution id was
    // validated against this tenant when execution was loaded/created above.
    await systemPrisma.agentExecution.update({
      where: { id: execution.id },
      data: {
        status: 'failed',
        // M5 — cap persisted error strings so they can't bloat the row.
        error: message.slice(0, 300),
        transcript: jsonValue(transcript),
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        executionTime: { increment: Date.now() - segmentStart },
        completedAt: new Date(),
      },
    })
    await notify({
      organizationId,
      userId,
      type: 'agent.error',
      level: 'error',
      title: `${agentMetadata.title || agent.description} hit an error`,
      body: message,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    throw error
  }
}

export async function executeAgentJob(job: Job<AgentExecutionJob>) {
  return runAgentExecution(job.data)
}
