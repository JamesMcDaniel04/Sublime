import type { Job } from 'bullmq'
import { createHash } from 'node:crypto'
import { prisma, systemPrisma } from '@/lib/prisma'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'
import { resolveHttpAuthRef } from '@/lib/flows/http-auth-ref'
import { agentHttpToolDefinition, agentHttpToolsFromMetadata } from '@/lib/agents/http-tools'
import { AgentHttpToolClient } from '@/lib/agents/http-tools-run'
import { retrieveContext, renderContext } from '@/lib/rag/retrieve'
import { buildContextRetrievedPayload, buildKnowledgeRetrievedPayload } from '@/lib/rag/retrieval-event'
import { createContextAssembler } from '@/lib/context/assemble'
import { retrieveKnowledge, renderKnowledge } from '@/lib/knowledge/retrieve'
import { embeddingsConfigured, embedQuery, embedTexts, cosineSimilarity } from '@/lib/rag/embeddings'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { indexExecution } from '@/lib/rag/indexer'
import {
  loadFlowPlaneGroups,
  loadMcpConnectionPlaneGroups,
  loadNativePlaneGroups,
  loadNangoPlaneGroups,
  loadPostgresPlaneGroups,
  toolName,
  type McpToolClient,
  type ToolBinding,
  type ToolPlaneGroup,
} from './tool-planes'
import type { GoalResource } from '@/lib/integrations/goals-port'
import { resolveAgentConnectorKeys } from '@/lib/connectors/agent-connectors'
import { agentReadScope } from '@/lib/server/visibility'
import { notify } from '@/lib/notifications/service'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { assertOrganizationBillingActive } from '@/lib/billing/enforce'
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
import { wrapUntrusted } from '@/lib/llm/guardrails'
import { coerceToIR } from '@/lib/llm/ir'
import { turnStopOutcome, turnEffortFor } from './turn-policy'
import { retrieveAgentMemory, renderAgentMemories, bestAnswerMatch, markMemoriesUsed, saveAgentMemory } from '@/lib/memory/agent-memory'
import { findOrgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'
import { reflectAndRemember } from './reflection'
import { shouldStrategize, goalSection, goalWorkSection, strategizeSection, STRATEGIZE_RETRIEVAL } from './strategy'
import { createPlan, applyPlanUpdate, auditPlan, PLAN_TOOLS, type RunPlan, type PlanStepStatus } from './plan-artifact'
import { isWriteProvider } from '@/lib/connectors/registry'
import { auditEgressHost } from '@/lib/agents/audit-host'
import { decryptRunValue, encryptRunText, encryptRunValue } from '@/lib/agents/run-crypto'
import { approvalQuestion, isApprovalReply, toolNeedsApproval, type PendingApproval } from './approval'
import { serializeToolResult } from '@/lib/agents/tool-result'
import { recordToolCallEvents } from '@/lib/behavior/record-event'
import { createRunBudget, chargeRunBudget, type RunBudget } from '@/lib/agents/run-budget'
import { goalGroundingBlock } from '@/lib/goals/grounding'

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
  // Loop-thread (Gumloop-parity threadAgent loop mode): seed this NEW run's
  // transcript from a prior execution's conversation (reload + append the new
  // input as a user turn) instead of starting fresh, so iterations of a
  // threaded loop chain one conversation forward. Only consulted when this is
  // a brand-new run (no executionId/resume) — see the transcript-init branch.
  continueExecutionId?: string
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
/** The stored credential/connection an agent HTTP tool authenticates with. */
function agentHttpCredentialRef(config: unknown): string | undefined {
  const ref = resolveHttpAuthRef((config ?? {}) as Record<string, unknown>)
  if (ref.kind === 'credential') return ref.credentialId
  if (ref.kind === 'connection') return ref.connectionId
  return undefined
}

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

async function loadTools(
  organizationId: string,
  providers: string[],
  ownerUserId?: string | null,
  query?: string,
  flowOptions?: { allowFlows?: boolean; flowIds?: string[]; resource?: GoalResource; depth?: number },
) {
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
        binding: { provider: group.provider, serverUrl: group.serverUrl, toolName: tool.name, client: group.client, credentialRef: group.id },
        isWrite: group.isWrite,
      })
    }
  }

  // ---- Per-org MCP connections (all active connections, any authType) ------
  // Custom MCP connections load for every agent regardless of the providers
  // list. A failing/unreachable server must NOT abort the run or block others.
  const mcpGroups = await loadMcpConnectionPlaneGroups(organizationId, ownerUserId)
  for (const group of mcpGroups) pushGroup(group, { cap: 20 })

  // ---- Native built-ins (Granola / Slack / HTTP / Email) --------------------
  // Each gated on its availability AND a matching providers entry.
  for (const group of await loadNativePlaneGroups(organizationId, {
    providers,
    resource: flowOptions?.resource,
    userId: ownerUserId,
  })) pushGroup(group)

  // ---- Nango delivery (outbound writes as the acting user) -----------------
  // Slack/Gmail/Salesforce writes through the org's Nango connections,
  // preferring the agent owner's own connection so messages arrive as the rep.
  // Gated per capability on both a matching providers entry and a resolvable
  // connection. Failures never abort the run.
  for (const group of await loadNangoPlaneGroups(organizationId, ownerUserId, { providers })) {
    pushGroup(group, { namePrefix: 'nango' })
  }

  // ---- Native Postgres (one group per connected database) ------------------
  // Gated on a matching providers entry — either the generic plane name or the
  // database's own name — so an agent attached to one database does not spend
  // the tool cap on every database the org has connected.
  for (const group of await loadPostgresPlaneGroups(organizationId, { providers })) pushGroup(group)

  // ---- Flow tool plane (agent -> flow) -------------------------------------
  // Flows appear as `flow_<slug>` tools whose input schema is the flow's input
  // node and whose result is its output node. Authorization: allowFlows plus
  // an optional flowIds narrowing; either way the pool is the ACTIVE flows
  // within the owner's read scope (loadFlowPlaneGroups enforces it).
  // Only when an acting user is known (dispatch runs as that user).
  if (ownerUserId && flowOptions?.allowFlows) {
    const flowGroups = await loadFlowPlaneGroups(organizationId, ownerUserId, {
      ...(flowOptions.flowIds?.length ? { flowIds: flowOptions.flowIds } : {}),
      depth: flowOptions.depth ?? 0,
    })
    for (const group of flowGroups) pushGroup(group)
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
 * Resume a suspended run (ask_user reply) — inline in dev, enqueued on the
 * worker in prod. Used by the reply route.
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
  const queue = getQueue(QUEUE_NAMES.AGENT_EXECUTION)
  await queue.add('resume-agent', { ...params, resume: true }, { jobId: `${params.executionId}-resume-${Date.now()}` })
}

export async function runAgentExecution(
  // Inline callers (e.g. the flow runtime) may pass onExecutionCreated to learn
  // the execution id as soon as its row exists — long before the run finishes —
  // so live UIs can start following the run. It is intentionally NOT part of
  // AgentExecutionJob: queue jobs are serialized and can't carry a function.
  // runBudget is likewise inline-only: the parent run passes its own budget
  // object BY REFERENCE into sub-runs so the whole tree spends one cap.
  data: AgentExecutionJob & { onExecutionCreated?: (executionId: string) => void | Promise<void>; runBudget?: RunBudget },
) {
  const { agentId, organizationId, userId } = data
  // Billing choke point: every execution path (cron, queue worker, Slack,
  // trigger webhook, resume) funnels through here, so an unpaid workspace's
  // automations stop even though these callers never hit requireAuthContext.
  await assertOrganizationBillingActive(organizationId)
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

  // Decrypt run data at rest back to its object form before any downstream read
  // (Array.isArray checks, coerceToIR, the plan seed). Identity for legacy
  // plaintext rows, so this is safe across the rollout. See run-crypto.ts.
  if (queuedExecution) {
    const mutable = queuedExecution as { transcript: unknown; plan: unknown }
    mutable.transcript = decryptRunValue(queuedExecution.transcript)
    mutable.plan = decryptRunValue(queuedExecution.plan)
  }

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
    } else if (queuedExecution.status === 'failed') {
      // A redelivered job whose row is already `failed` (the previous attempt's
      // catch wrote it, or the reaper terminalized it) must THROW, not resolve:
      // resolving marks the BullMQ job completed, so the 'failed' event never
      // fires and the failure never reaches the dead-letter queue or Sentry.
      throw new Error(`Execution ${queuedExecution.id} already failed — dead-lettering redelivered job`)
    } else {
      return { status: queuedExecution.status, skipped: true as const }
    }
  }

  let transcript: unknown[]
  let pendingResults: ToolResult[] | null = null
  // A held write-tool call whose approval reply arrived with this resume; it
  // executes (or is denied) once tool bindings are loaded below.
  let approvalToResolve: (PendingApproval & { approved: boolean; reply: string }) | null = null
  let startTurn = 0
  // On any resume, already-succeeded tool steps form an idempotency ledger so a
  // replayed call reuses its stored output instead of re-firing.
  let completedToolSteps = new Map<string, unknown>()

  if (resuming && queuedExecution) {
    const executionMetadata = metadataOf(queuedExecution.metadata)
    const heldApproval = executionMetadata.pendingApproval as PendingApproval | undefined
    // pendingQuestion is also written as a display mirror while an approval is
    // held, so the approval check must come first on resume.
    const pending = heldApproval ? undefined : (executionMetadata.pendingQuestion as PendingQuestion | undefined)
    const waiting = queuedExecution.status === 'waiting_for_input'
    if (!waiting || (!pending && !heldApproval) || !Array.isArray(queuedExecution.transcript)) {
      throw new Error('Execution is not waiting for input')
    }
    // Atomic claim: two concurrent replies — e.g. builder and Activity page
    // both open — must not both resume. Exactly one caller flips
    // waiting_for_input -> running; the loser errors cleanly here.
    // systemPrisma: id-keyed terminal write on worker job data; execution id was
    // validated against this tenant when queuedExecution was loaded above.
    const claimed = await systemPrisma.agentExecution.updateMany({
      where: { id: queuedExecution.id, status: 'waiting_for_input' },
      data: { status: 'running' },
    })
    if (claimed.count === 0) {
      throw new Error('Execution is not waiting for input')
    }
    // Normalize to the provider-neutral IR so a run persisted in a native shape
    // (pre-IR, or by the other provider) resumes on whatever provider routes now.
    transcript = coerceToIR(queuedExecution.transcript as unknown[])
    startTurn = Number(executionMetadata.turnCursor) || 0
    completedToolSteps = await loadCompletedToolSteps(queuedExecution.id)
    if (heldApproval) {
      // Approval resolution is deny-by-default, is NEVER auto-answered from
      // memory, and the reply is NOT saved as a reusable user_answer memory —
      // approvals must be collected fresh every time. The held call executes
      // (or is denied) once tool bindings are loaded below.
      const reply = data.reply?.trim() || ''
      approvalToResolve = { ...heldApproval, approved: isApprovalReply(reply), reply }
      await recordEvent(queuedExecution.id, heldApproval.stepId || null, 'user.replied', {
        answer: reply || '(no reply)',
        approval: true,
      })
    } else if (pending) {
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
      // Await persistence so a new run started immediately after this resume can
      // reliably reuse the answer instead of racing the background write.
      await saveAgentMemory({
        organizationId,
        agentId,
        kind: 'user_answer',
        title: pending.question.slice(0, 120),
        content: reply,
        question: pending.question,
        sourceExecutionId: queuedExecution.id,
      })
    }
  } else if (resumeFromCrash && queuedExecution) {
    transcript = coerceToIR(queuedExecution.transcript as unknown[])
    startTurn = Number(metadataOf(queuedExecution.metadata).turnCursor) || 0
    completedToolSteps = await loadCompletedToolSteps(queuedExecution.id)
    await recordEvent(queuedExecution.id, null, 'run.resumed', { fromTurn: startTurn })
  } else if (data.continueExecutionId) {
    // Loop-thread: seed this run's transcript from a prior execution's
    // conversation, then append the new input as a fresh user turn — multi-turn
    // batch memory across loop iterations. A missing/blank prior transcript
    // degrades to a fresh conversation.
    const prior = await prisma.agentExecution.findFirst({
      where: { id: data.continueExecutionId, agentTaskId: agentId, organizationId },
      select: { transcript: true },
    })
    const priorTranscript = decryptRunValue(prior?.transcript)
    if (Array.isArray(priorTranscript) && priorTranscript.length) {
      transcript = coerceToIR(priorTranscript as unknown[])
      runner.appendUserMessage(transcript, data.input || agent.objective)
    } else {
      transcript = runner.start(data.input || agent.objective)
    }
  } else {
    transcript = runner.start(data.input || agent.objective)
  }

  const claimExecution = async () => {
    if (!queuedExecution) return null
    if (resuming || resumeFromCrash) {
      // The atomic waiting->running claim (resume) already happened above, and
      // a crash-resume adopts a row that is still 'running'.
      // startedAt is refreshed in BOTH cases: the stuck-run reaper keys on it,
      // so a run resumed after a >reaper-window human reply delay — or a stall
      // redelivery arriving up to lockDuration after a crash — would otherwise
      // be failed by the reaper while actively executing. (The flow path
      // already does this in its waiting->running claim.)
      // systemPrisma: id-keyed write on worker job data; execution id was
      // validated against this tenant when queuedExecution was loaded above.
      return systemPrisma.agentExecution.update({
        where: { id: queuedExecution.id },
        data: {
          status: 'running',
          model: runner.model,
          startedAt: new Date(),
          ...(resuming
            ? { metadata: jsonValue({ ...metadataOf(queuedExecution.metadata), pendingQuestion: null, pendingApproval: null }) }
            : {}),
        },
      })
    }
    // Fresh queued run: claim pending->running atomically. If the row is no
    // longer pending (the reaper failed it, or the user cancelled it), this
    // job must not run — and must never resurrect a terminal row into
    // 'running' (the "failure notification, then completion notification"
    // incident class).
    // systemPrisma: id-keyed claim on worker job data; tenant-validated above.
    const claimed = await systemPrisma.agentExecution.updateMany({
      where: { id: queuedExecution.id, status: 'pending' },
      data: { status: 'running', model: runner.model, startedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new Error(`Execution ${queuedExecution.id} is no longer pending — refusing to run a terminalized row`)
    }
    // systemPrisma: id-keyed read-back of the row claimed just above.
    const row = await systemPrisma.agentExecution.findUnique({ where: { id: queuedExecution.id } })
    if (!row) throw new Error(`Execution ${queuedExecution.id} vanished after claim`)
    return row
  }

  const execution =
    (await claimExecution()) ??
    (await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'running',
          model: runner.model,
          input: encryptRunValue({ prompt: data.input || agent.objective }),
          trigger: { type: 'schedule' },
          metadata: { title: agentMetadata.title || agent.description },
          userId,
          organizationId,
        },
      }))

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
      data: { executionId: execution.id, role: 'user', content: encryptRunText(data.input || agent.objective) },
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
        data: { executionId: execution.id, role: 'agent', content: encryptRunText(cancelSummary) },
      })
      // systemPrisma: id-keyed terminal write on worker job data; execution id was
      // validated against this tenant when execution was loaded/created above.
      await systemPrisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'cancelled',
          error: null,
          transcript: jsonValue(encryptRunValue(transcript)),
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

  // Cross-tool ledger (behavior spec §2): providers this run actually
  // touched, deduped to one tool_call event per (execution, provider).
  // Declared OUTSIDE the try so the failure path can flush it too — a run
  // that threw still used the integrations it used.
  const touchedTools = new Map<string, Set<string>>()

  try {
    // Enforce the workspace's monthly token ceiling before doing any model work.
    // The run's owner is passed so exempt admin accounts are never blocked.
    const budget = await checkMonthlyTokenBudget(organizationId, userId)
    if (budget.over) {
      throw new Error(
        `Monthly token budget reached for this workspace (${budget.used.toLocaleString()}/${budget.limit.toLocaleString()} tokens). Buy additional credits in Settings → Billing, upgrade the plan, or wait for the next cycle.`,
      )
    }

    // Per-run token backstop against a pathological loop (independent of the
    // monthly ceiling). ONE budget object per run TREE: sub-runs receive this
    // same object by reference, so recursion cannot multiply the cap. Seeded
    // with prior spend on crash-resume from the row's persisted totals.
    const runBudget: RunBudget =
      data.runBudget ??
      createRunBudget(
        process.env.AGENT_MAX_RUN_TOKENS,
        queuedExecution ? (queuedExecution.inputTokens ?? 0) + (queuedExecution.outputTokens ?? 0) : 0,
      )

    // Typed connector bindings gate tool loading; falls back to
    // metadata.integrations for agents created before the FK existed.
    const providers = await resolveAgentConnectorKeys(agent.id, agentMetadata)
    const skillIds = Array.isArray(agentMetadata.skills) ? agentMetadata.skills.map(String) : []
    const toolQuery = [agent.objective, data.input].filter(Boolean).join('\n')
    const { tools, bindings } = await loadTools(organizationId, providers, userId, toolQuery, {
      allowFlows: agentMetadata.allowFlows === true,
      flowIds: Array.isArray(agentMetadata.flowIds) ? agentMetadata.flowIds.map(String) : [],
      resource: { type: 'agent', id: agent.id },
      // Shared recursion counter: a child flow started by this agent runs at
      // this agent's depth + 1 (see loadFlowPlaneGroups), so agent<->flow
      // cycles are bounded by the subflow cap instead of resetting per hop.
      depth: data.depth ?? 0,
    })
    // User-configured HTTP API endpoints (metadata.httpTools): each becomes a
    // real tool executed through the flow HTTP engine with vault credentials.
    // Added after the cap so a configured endpoint is never crowded out by
    // discovered tools — the user explicitly built it for this agent.
    for (const httpTool of agentHttpToolsFromMetadata(agentMetadata)) {
      const definition = agentHttpToolDefinition(httpTool)
      if (bindings.has(definition.name)) continue
      tools.push(definition)
      bindings.set(definition.name, {
        provider: 'http',
        serverUrl: '',
        toolName: definition.name,
        client: new AgentHttpToolClient(httpTool, { organizationId, userId }),
        // Agent HTTP tools persist the same config shape as a flow http step,
        // so the same rule decides what authenticates them.
        ...(agentHttpCredentialRef(httpTool.config) ? { credentialRef: agentHttpCredentialRef(httpTool.config) } : {}),
        ...(httpTool.config.requireApproval === true ? { requireApproval: true } : {}),
      })
    }
    // Resolve only attached skills this run owner can still see. Visibility
    // changes take effect immediately even if an old id remains attached.
    const communitySkills = skillIds.length
      ? await systemPrisma.sharedSkill
          .findMany({
            where: {
              id: { in: skillIds },
              isActive: true,
              OR: [
                { visibility: 'public' },
                { organizationId, visibility: 'organization' },
                { organizationId, userId, visibility: 'private' },
              ],
            },
            select: { id: true, name: true, instructions: true },
          })
          .catch(() => [])
      : []
    // Persona narrative as ambient workspace context — background only, never
    // task instructions. Best-effort: a missing row or read failure is a no-op.
    const personaRow = await prisma.organizationPersona
      .findUnique({ where: { organizationId }, select: { narrative: true } })
      .catch(() => null)
    let system = buildAgentSystemPrompt(
      agent.objective,
      skillIds,
      communitySkills,
      personaRow?.narrative ? { orgContext: personaRow.narrative } : {},
    )
    if (structuredFields.length) {
      system += `\n\n${structuredResponseInstruction(structuredFields)}`
    }

    // Goal awareness + strategize mode (WS1.9). The goal steers every turn;
    // complex tasks are told to plan before acting.
    const goalBlock = goalSection((agent as { goal?: string | null }).goal)
    if (goalBlock) system += `\n\n${goalBlock}`
    const organizationGoals = await goalGroundingBlock(organizationId)
    if (organizationGoals) system += `\n\n${organizationGoals}`
    // Derived from the tools this run actually loaded, so an agent is only
    // ever told to log work when it genuinely holds log_work.
    const goalWork = goalWorkSection(tools)
    if (goalWork) system += `\n\n${goalWork}`
    // Keep the exact linked goals used to ground this run. Reflection verdicts
    // must land on these same goals, not a second arbitrarily ordered query.
    let groundedGoalIds: string[] | null = null
    let linkedGoalContext: string | null = null
    // Multi-goal arbitration + per-goal work feedback. Best-effort: a
    // learning-layer failure must never stop a run that would otherwise do
    // useful work. Work feedback stays bounded to two goals so a many-goal
    // agent cannot grow an unbounded prompt — but it now loads in ARBITRATION
    // order, so the two goals it learns about are the two that matter most.
    try {
      const { resolveLinkedGoalIds } = await import('@/lib/integrations/goals-port')
      const linkedGoalIds = await resolveLinkedGoalIds(organizationId, {
        type: 'agent',
        id: agent.id,
      })
      let orderedGoalIds = linkedGoalIds
      if (linkedGoalIds.length > 0) {
        const { rankGoals, arbitrationSection } = await import('@/lib/goals/arbitration')
        const rows = await prisma.goal.findMany({
          where: { id: { in: linkedGoalIds }, organizationId, status: 'active' },
          select: { id: true, name: true, riskLevel: true, targetDate: true, priority: true },
        })
        const ranked = rankGoals(
          rows.map((row) => ({ ...row, riskLevel: row.riskLevel as 'on_track' | 'at_risk' | 'off_track' | 'no_data' })),
        )
        if (linkedGoalIds.length >= 2) {
          const arbitration = arbitrationSection(ranked)
          if (arbitration) system += `\n\n${arbitration}`
        }
        orderedGoalIds = ranked.map((row) => row.id)
        groundedGoalIds = orderedGoalIds.slice(0, 2)
        linkedGoalContext = ranked
          .slice(0, 2)
          .map((row, index) => `${index + 1}. ${row.name} (${row.riskLevel}, due ${row.targetDate.toISOString().slice(0, 10)})`)
          .join('\n')
      }
      if (goalWork) {
        const [{ loadWorkFeedback }, { renderWorkFeedback }] = await Promise.all([
          import('@/lib/goals/work-rules-port'),
          import('@/lib/goals/work-feedback'),
        ])
        for (const linkedGoalId of orderedGoalIds.slice(0, 2)) {
          const feedback = await loadWorkFeedback(organizationId, linkedGoalId, agent.id)
          if (!feedback) continue
          const block = renderWorkFeedback(feedback)
          if (block) system += `\n\n${block}`
        }
      }
    } catch {
      // Non-fatal by design.
    }
    const strategize = shouldStrategize({ objective: agent.objective, metadata: agentMetadata, toolCount: tools.length })
    if (strategize) {
      system += `\n\n${strategizeSection()}`
      // The plan tools only exist where the prompt demands a plan — offering
      // them to a simple run would be an instruction to bureaucratize it.
      tools.push(...PLAN_TOOLS)
    }

    // Multi-agent handoff: an opted-in agent can delegate to other agents via a
    // run_agent tool (fan-out over a set, or sequential pipeline stages). Bounded
    // by depth, a per-run count cap, and a cycle guard; sub-runs spend from THIS
    // run's token budget (shared runBudget object), so the whole tree is bounded
    // by one per-run cap. Only offered to runs under the depth cap.
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
          ...agentReadScope(userId),
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
              runBudget,
            })
            // A completed sub-run returns { summary }; a suspended one (asked
            // the user) returns { status: 'waiting_*' }.
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
      const retrievalQuery = `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000)
      const ragContext = await retrieveContext(getGraphRagStore(), {
        organizationId,
        // Scope correlated context to this rep: shared org data + their own
        // private nodes, never another rep's private book.
        viewerUserId: userId,
        query: retrievalQuery,
        seedNodeIds,
        ...(strategize ? { topK: STRATEGIZE_RETRIEVAL.topK, hops: STRATEGIZE_RETRIEVAL.hops } : {}),
      })
      const budgeted = {
        hits: contextAssembler.take(ragContext.hits, (h) => h.text, (h) => h.score),
        related: contextAssembler.take(ragContext.related, (r) => r.text, () => undefined),
      }
      const rendered = renderContext(budgeted)
      if (rendered) {
        system = `${system}\n\n${wrapUntrusted(rendered)}`
        // Surface the correlated context in the run's activity log so the
        // "brain" is visible: what Sales AI signals / prior runs / related
        // accounts the agent pulled in before acting — and, since the
        // enrichment (run traces), HOW it was found: strategy, per-hit
        // scores, the stage funnel, and how much survived the budget.
        await recordEvent(execution.id, null, 'context.retrieved',
          buildContextRetrievedPayload({
            query: retrievalQuery,
            trace: ragContext.trace,
            hits: budgeted.hits.map((h) => ({ type: h.type, text: h.text, score: h.score })),
            related: budgeted.related.map((r) => ({ type: r.type, text: r.text })),
            offeredHits: ragContext.hits.length,
            injectedChars: rendered.length,
          }))
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
      const knowledgeQuery = `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000)
      const knowledgeHits = await retrieveKnowledge({
        organizationId,
        agentId: agent.id,
        userId,
        query: knowledgeQuery,
      })
      const budgetedKnowledge = contextAssembler.take(knowledgeHits, (h) => h.content, (h) => h.score)
      const knowledgeBlock = renderKnowledge(budgetedKnowledge)
      if (knowledgeBlock) {
        system = `${system}\n\n${wrapUntrusted(knowledgeBlock)}`
        await recordEvent(execution.id, null, 'knowledge.retrieved',
          buildKnowledgeRetrievedPayload({
            query: knowledgeQuery,
            chunks: budgetedKnowledge.map((h) => ({ filename: h.filename, score: h.score })),
            offered: knowledgeHits.length,
            injectedChars: knowledgeBlock.length,
          }))
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
        system = `${system}\n\n${wrapUntrusted(memoryBlock)}`
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

    // Resolve a held write-tool approval (deny-by-default): the held call's
    // outcome — real output, denial, or execution error — becomes the pending
    // tool_use's result, exactly like an ask_user reply resolves its call.
    if (approvalToResolve) {
      const held = approvalToResolve
      let content: string
      let isError = false
      if (!held.approved) {
        if (held.stepId) {
          await prisma.workflowStep.update({
            where: { id: held.stepId },
            data: { status: 'failed', error: jsonValue({ message: 'Denied by the user' }), completedAt: new Date() },
          })
        }
        await recordEvent(execution.id, held.stepId || null, 'approval.denied', { name: held.node, reply: held.reply })
        content = JSON.stringify({
          error: `The user denied this action${held.reply ? ` and said: ${held.reply}` : ''}. Do not retry it as-is — adjust your plan or finish without it.`,
        })
        isError = true
      } else {
        const heldBinding = bindings.get(held.toolName)
        if (!heldBinding) {
          if (held.stepId) {
            await prisma.workflowStep.update({
              where: { id: held.stepId },
              data: { status: 'failed', error: jsonValue({ message: 'Tool no longer available' }), completedAt: new Date() },
            })
          }
          content = JSON.stringify({ error: `Approved, but the tool ${held.toolName} is no longer available.` })
          isError = true
        } else {
          try {
            const result = await heldBinding.client.executeTool(heldBinding.serverUrl, heldBinding.toolName, held.input)
            if (held.stepId) {
              await prisma.workflowStep.update({
                where: { id: held.stepId },
                data: { status: 'succeeded', output: jsonValue(result), completedAt: new Date() },
              })
            }
            await recordEvent(execution.id, held.stepId || null, 'approval.approved', { name: held.node })
            const heldHost = auditEgressHost(held.input, heldBinding.serverUrl)
            const heldDetail: Record<string, unknown> = {}
            if (heldBinding.credentialRef) heldDetail.credentialRef = heldBinding.credentialRef
            if (heldHost) heldDetail.host = heldHost
            await recordAudit({
              organizationId,
              executionId: execution.id,
              actorUserId: userId,
              actorKind: 'agent',
              action: isWriteProvider(heldBinding.provider) ? 'tool.write' : 'tool.call',
              tool: held.toolName,
              resourceType: heldBinding.provider,
              payload: held.input,
              // Which stored credential authenticated the call and which host it
              // reached — the join a key rotation needs. References, never secrets.
              ...(Object.keys(heldDetail).length ? { detail: heldDetail } : {}),
            })
            content = serializeToolResult(result)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (held.stepId) {
              await prisma.workflowStep.update({
                where: { id: held.stepId },
                data: { status: 'failed', error: jsonValue({ message }), completedAt: new Date() },
              })
            }
            await recordEvent(execution.id, held.stepId || null, 'tool.failed', { name: held.node, error: message })
            content = serializeToolResult({ error: message })
            isError = true
          }
        }
      }
      pendingResults = [
        ...(held.collectedResults || []),
        { toolCallId: held.toolCallId, content, ...(isError ? { isError: true } : {}) },
      ]
    }

    if (pendingResults) runner.appendToolResults(transcript, pendingResults)

    const maxTurns = Number(agentMetadata.maxTurns) || Number(process.env.AGENT_MAX_TURNS) || 16
    const requireApproval = agentMetadata.requireApproval === true
    const monthlyLimit = budget.limit
    let finalText = ''
    let planEmitted = false
    // The persisted in-run plan (plan-artifact.ts). Seeded from the row so a
    // resumed run keeps the plan it set before suspending; written back on
    // every change so the artifact survives crashes mid-run.
    const seededPlan = decryptRunValue(execution.plan)
    let runPlan: RunPlan | null =
      seededPlan && typeof seededPlan === 'object' && !Array.isArray(seededPlan)
        ? (seededPlan as unknown as RunPlan)
        : null
    const persistPlan = async () => {
      // systemPrisma: id-keyed plan checkpoint on worker job data; execution id
      // was validated against this tenant when it was loaded/created above.
      await systemPrisma.agentExecution.update({
        where: { id: execution.id },
        data: { plan: jsonValue(encryptRunValue(runPlan)) },
      })
    }
    // Why the run stopped early, if it did — drives the run.capped event and a
    // distinct (non-success) completion notification.
    let cappedReason: 'per_run_token_cap' | 'monthly_budget' | 'max_turns' | 'model_refusal' | 'model_incomplete' | null = null

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

      const turnResult = await runner.next(transcript, system, [...tools, ASK_USER_TOOL], turnEffortFor(turn, startTurn))
      usage.inputTokens += turnResult.usage.inputTokens
      usage.outputTokens += turnResult.usage.outputTokens

      // Record this turn's spend on the live cross-process counter, then enforce
      // both the per-run cap (shared across the whole sub-agent tree) and the
      // (in-flight-aware) monthly ceiling mid-run so a runaway can't blow far
      // past the budget between the start-of-run check and completion.
      const overRunCap = chargeRunBudget(runBudget, turnResult.usage.inputTokens + turnResult.usage.outputTokens)
      const monthTotal = await recordTokenUsage(organizationId, turnResult.usage.inputTokens + turnResult.usage.outputTokens)
      if (overRunCap) {
        finalText = turnResult.text || 'Run stopped: it reached its per-run token cap.'
        cappedReason = 'per_run_token_cap'
        await recordEvent(execution.id, null, 'run.capped', { reason: 'per_run_token_cap', runTotal: runBudget.spent, cap: runBudget.cap })
        break
      }
      if (monthlyLimit > 0 && (monthTotal ?? 0) >= monthlyLimit) {
        finalText = turnResult.text || 'Run stopped: the workspace monthly token budget was reached.'
        cappedReason = 'monthly_budget'
        await recordEvent(execution.id, null, 'run.capped', { reason: 'monthly_budget', monthTotal, limit: monthlyLimit })
        break
      }

      // A refusal or a truncated/paused turn is NOT a natural completion — it
      // must not fall through to the "no tool calls → done" branch below,
      // which would otherwise dress up a declined or cut-off reply as a
      // normal finished run.
      const stopOutcome = turnStopOutcome(turnResult)
      if (stopOutcome.capped) {
        finalText = stopOutcome.finalText
        cappedReason = stopOutcome.capped
        await recordEvent(execution.id, null, 'run.capped', { reason: stopOutcome.capped, stopReason: turnResult.stopReason })
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
      let pendingApprovalRequest: PendingApproval | null = null

      for (const call of turnResult.toolCalls) {
        if (call.name === ASK_USER_TOOL.name) {
          // At most ONE suspension per turn. A run suspends by leaving exactly
          // one tool_use id unresolved (it becomes pendingQuestion.toolCallId,
          // resolved on resume); a second unresolved id would orphan a tool
          // call and make the persisted transcript unreplayable. So any
          // further ask gets a covering result. A held approval counts as the
          // turn's one suspension too.
          if (pendingAsk || pendingApprovalRequest) {
            results.push({
              toolCallId: call.id,
              content: JSON.stringify({ error: 'You can only pause once per turn (a question is already pending). Ask again after it resolves.' }),
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

        // Plan meta-tools: handled inline like ask_user (no binding, no
        // workflow step) — they mutate the run's own artifact, not the world.
        if (call.name === 'set_plan' || call.name === 'update_plan') {
          if (call.name === 'set_plan') {
            const titles = Array.isArray(call.input.steps) ? call.input.steps.map(String) : []
            const plan = createPlan(titles)
            if (!plan.steps.length) {
              results.push({ toolCallId: call.id, content: JSON.stringify({ error: 'set_plan needs at least one non-empty step.' }), isError: true })
              continue
            }
            runPlan = plan
            await persistPlan()
            await recordEvent(execution.id, null, 'agent.plan_set', { steps: runPlan.steps })
            results.push({ toolCallId: call.id, content: JSON.stringify({ ok: true, steps: runPlan.steps }) })
            continue
          }
          if (!runPlan) {
            results.push({ toolCallId: call.id, content: JSON.stringify({ error: 'No plan exists yet — call set_plan first.' }), isError: true })
            continue
          }
          const status = String(call.input.status ?? '')
          if (status !== 'done' && status !== 'failed' && status !== 'skipped') {
            results.push({ toolCallId: call.id, content: JSON.stringify({ error: 'status must be done, failed, or skipped.' }), isError: true })
            continue
          }
          const outcome = applyPlanUpdate(runPlan, {
            stepN: Number(call.input.stepN),
            status: status as PlanStepStatus,
            note: typeof call.input.note === 'string' ? call.input.note : undefined,
            revisedSteps: Array.isArray(call.input.revisedSteps) ? call.input.revisedSteps.map(String) : undefined,
            turn,
          })
          if (outcome.error || !outcome.plan) {
            results.push({ toolCallId: call.id, content: JSON.stringify({ error: outcome.error ?? 'plan update failed' }), isError: true })
            continue
          }
          runPlan = outcome.plan
          await persistPlan()
          await recordEvent(execution.id, null, 'agent.plan_updated', { steps: runPlan.steps, revisions: runPlan.revisions })
          results.push({ toolCallId: call.id, content: JSON.stringify({ ok: true, steps: runPlan.steps }) })
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
            results.push({ toolCallId: call.id, content: serializeToolResult(cached) })
            continue
          }

          // Approval gate: on an opted-in agent, a write-plane call suspends
          // for human approval instead of executing (replayed calls above
          // already ran and never re-ask). Same one-suspension-per-turn
          // invariant as ask_user.
          if (
            binding.requireApproval === true ||
            toolNeedsApproval({ requireApproval, provider: binding.provider, input: (call.input ?? null) as Record<string, unknown> | null })
          ) {
            if (pendingApprovalRequest || pendingAsk) {
              await prisma.workflowStep.update({
                where: { id: step.id },
                data: { status: 'failed', error: jsonValue({ message: 'Deferred: another pause is already pending this turn' }), completedAt: new Date() },
              })
              results.push({
                toolCallId: call.id,
                content: JSON.stringify({ error: 'Another pause is already pending this turn. Re-issue this action after it resolves.' }),
                isError: true,
              })
              continue
            }
            await prisma.workflowStep.update({ where: { id: step.id }, data: { status: 'waiting' } })
            await recordEvent(execution.id, step.id, 'approval.requested', { name: step.node, args: call.input })
            pendingApprovalRequest = {
              toolCallId: call.id,
              toolName: call.name,
              node: step.node,
              input: (call.input ?? {}) as Record<string, unknown>,
              stepId: step.id,
              collectedResults: [],
            }
            continue
          }

          const result = await binding.client.executeTool(binding.serverUrl, binding.toolName, call.input)
          const touched = touchedTools.get(binding.provider) ?? new Set<string>()
          touched.add(binding.toolName)
          touchedTools.set(binding.provider, touched)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'succeeded', output: jsonValue(result), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.completed', { name: step.node })
          // Immutable audit trail. Write classification derives from the
          // connector registry (isWriteProvider) — nango:*, slack, email, AND
          // the http builtin — never a local regex that can drift from it.
          // Recover the destination host for the audit detail (payload is
          // hashed, so the host would otherwise be unrecoverable — see
          // auditEgressHost). "Rotate this key, show me every host it reached"
          // is now answerable on the agent plane too, not just flow HTTP.
          const auditHost = auditEgressHost(call.input, binding.serverUrl)
          const auditDetail: Record<string, unknown> = {}
          if (binding.credentialRef) auditDetail.credentialRef = binding.credentialRef
          if (auditHost) auditDetail.host = auditHost
          await recordAudit({
            organizationId,
            executionId: execution.id,
            actorUserId: userId,
            actorKind: 'agent',
            action: isWriteProvider(binding.provider) ? 'tool.write' : 'tool.call',
            tool: call.name,
            resourceType: binding.provider,
            payload: call.input,
            ...(Object.keys(auditDetail).length ? { detail: auditDetail } : {}),
          })
          results.push({ toolCallId: call.id, content: serializeToolResult(result) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'failed', error: jsonValue({ message }), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.failed', { name: step.node, error: message })
          results.push({ toolCallId: call.id, content: serializeToolResult({ error: message }), isError: true })
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

        // Remembered blocking answers are reused by default. An agent may opt
        // out explicitly when its workflow must collect a fresh answer every
        // run (for example, a rotating approval decision).
        if (suggestedAnswer && agentMetadata.autoAnswerFromMemory !== false) {
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
          data: { executionId: execution.id, role: 'agent', content: encryptRunText(pendingAsk.question) },
        })
        // systemPrisma: id-keyed terminal write on worker job data; execution id was
        // validated against this tenant when execution was loaded/created above.
        await systemPrisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'waiting_for_input',
            transcript: jsonValue(encryptRunValue(transcript)),
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

      if (pendingApprovalRequest) {
        // Suspend for approval, mirroring the ask_user pause: the held call's
        // tool_use id stays unresolved and this turn's other results ride
        // along in collectedResults. pendingApproval is the authoritative
        // marker (checked FIRST on resume); pendingQuestion is written too so
        // the activity pane renders the question + reply box unchanged.
        pendingApprovalRequest.collectedResults = results
        const question = approvalQuestion(pendingApprovalRequest.node, pendingApprovalRequest.input)
        await prisma.executionMessage.create({
          data: { executionId: execution.id, role: 'agent', content: encryptRunText(question) },
        })
        await recordEvent(execution.id, pendingApprovalRequest.stepId, 'agent.question', { question, approval: true })
        // systemPrisma: id-keyed terminal write on worker job data; execution id was
        // validated against this tenant when execution was loaded/created above.
        await systemPrisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'waiting_for_input',
            transcript: jsonValue(encryptRunValue(transcript)),
            inputTokens: { increment: usage.inputTokens },
            outputTokens: { increment: usage.outputTokens },
            executionTime: { increment: Date.now() - segmentStart },
            metadata: jsonValue({
              ...executionMetadata,
              // Resume continues at the next turn (the approval completes this one).
              turnCursor: turn + 1,
              pendingApproval: pendingApprovalRequest,
              pendingQuestion: {
                toolCallId: pendingApprovalRequest.toolCallId,
                question,
                stepId: pendingApprovalRequest.stepId,
                collectedResults: [],
              } satisfies PendingQuestion,
            }),
          },
        })
        await notify({
          organizationId,
          userId,
          type: 'agent.needs_input',
          level: 'action',
          title: `${agentMetadata.title || agent.description} needs your approval`,
          body: question,
          agentTaskId: agent.id,
          executionId: execution.id,
        })
        return { status: 'waiting_for_input', question, executionId: execution.id }
      }

      runner.appendToolResults(transcript, results)

      // Durable checkpoint at a clean turn boundary (results appended → the
      // stored transcript is a valid, resumable conversation). A crash/retry
      // after this resumes from turn+1 instead of losing prior turns.
      // jsonb merge (not a spread of the boot-time snapshot): metadata written
      // to the row DURING the loop — a pending cancel marker, a reply — must
      // not be silently reverted by each turn's checkpoint.
      // systemPrisma: id-keyed checkpoint write on worker job data; execution id
      // was validated against this tenant when execution was loaded/created above.
      await systemPrisma.$executeRaw`
        UPDATE "agent_executions"
        SET "transcript" = ${JSON.stringify(encryptRunValue(transcript))}::jsonb,
            "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object('turnCursor', ${turn + 1}::int)
        WHERE "id" = ${execution.id}`
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

    // Turn exhaustion is a cap, not a success: the model still wanted to call
    // tools when the loop ran out. Make it observable (run.capped + a distinct
    // summary) instead of dressing it up as a normal completion. The turn's
    // tool work is already checkpointed on the run's steps.
    if (!finalText) {
      cappedReason = 'max_turns'
      await recordEvent(execution.id, null, 'run.capped', { reason: 'max_turns', maxTurns })
    }
    const summary =
      finalText ||
      `Run stopped at its turn limit (${maxTurns}) before producing a final answer. Work completed so far is preserved in the run's steps.`
    // Plan-vs-actual audit: deterministic findings on how the run's recorded
    // plan matched what actually happened. On the output for operators, in
    // the reflection prompt so the next run's critique addresses them.
    const planFindings = auditPlan(runPlan, strategize)
    let output: Record<string, unknown> = {
      summary,
      ...(cappedReason ? { capped: cappedReason } : {}),
      ...(planFindings.length ? { planFindings } : {}),
    }
    if (structuredFields.length) {
      const parsed = parseStructuredAgentOutput(finalText, structuredFields)
      if (parsed.output) {
        output = { ...output, structured: parsed.output }
      } else {
        // Loud, but the text answer keeps its value: surface the contract
        // violation on the run instead of silently shipping unstructured text.
        output = { ...output, structuredError: parsed.error }
        await recordEvent(execution.id, null, 'agent.structured_output_invalid', { error: parsed.error })
      }
    }
    const headline = await generateHeadline(summary)

    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'agent', content: encryptRunText(summary) },
    })
    // Status-guarded terminal write: only a still-running row may be
    // completed. If the reaper (or a cancel that landed after the
    // liveBeforeCompletion check) already terminalized this row, that terminal
    // state wins — completing over it would resurrect a run the user was
    // already told failed/was cancelled.
    // systemPrisma: id-keyed terminal writes on worker job data; execution/agent
    // ids were validated against this tenant when they were loaded/created above.
    const completionClaim = await systemPrisma.agentExecution.updateMany({
      where: { id: execution.id, status: 'running' },
      data: {
        status: 'completed',
        output: jsonValue(encryptRunValue(output)),
        transcript: jsonValue(encryptRunValue(transcript)),
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        executionTime: { increment: Date.now() - segmentStart },
        completedAt: new Date(),
        metadata: jsonValue({ ...executionMetadata, pendingQuestion: null, pendingApproval: null, ...(headline ? { headline } : {}) }),
      },
    })
    if (completionClaim.count === 0) {
      const live = await systemPrisma.agentExecution
        .findUnique({ where: { id: execution.id }, select: { status: true } })
        .catch(() => null)
      await recordEvent(execution.id, null, 'run.completion_superseded', { liveStatus: live?.status ?? 'unknown' })
      return { status: live?.status ?? 'failed', skipped: true as const }
    }
    await systemPrisma.agentTask.update({
      where: { id: agent.id },
      data: {
        lastExecutedAt: new Date(),
        executionCount: { increment: 1 },
        lastResult: jsonValue(output),
      },
    })
    await notify({
      organizationId,
      userId,
      type: 'agent.completed',
      level: cappedReason ? 'info' : 'success',
      title: cappedReason
        ? `${agentMetadata.title || agent.description} stopped at a limit`
        : `${agentMetadata.title || agent.description} completed`,
      body: headline || summary,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    // Cross-tool ledger flush: await the durable write before advertising
    // completion, while keeping capture failure non-fatal to the agent run.
    await recordToolCallEvents({
      organizationId,
      userId,
      executionId: execution.id,
      touched: touchedTools,
      succeeded: true,
    }).catch(() => undefined)
    // Index this run (output + correlated entities) into the graph-RAG store so
    // future agents/assistant answers can draw on what happened here. Fire and
    // forget — gated on embeddings, never blocks completion.
    void indexExecution({
      id: execution.id,
      organizationId,
      agentTaskId: agent.id,
      agentTitle: (agentMetadata.title as string) || agent.description,
      input: queuedExecution?.input ?? { prompt: data.input },
      output,
      status: 'completed',
      // Runs inherit the agent's scope: a private agent's runs stay private to
      // its owner, matching executionVisibilityScope for row-level access.
      ownerUserId: agent.userId ?? null,
      visibility: agent.visibility === 'private' ? 'private' : 'shared',
    }).catch(() => undefined)
    // Durable knowledge capture is separate from operational run retention:
    // logs/transcripts may be pruned, but the encrypted outcome remains
    // searchable until the user deletes it or the workspace is removed.
    void import('@/lib/knowledge/capture')
      .then(({ captureAgentRunKnowledge }) => captureAgentRunKnowledge({
        organizationId,
        userId,
        agentId: agent.id,
        executionId: execution.id,
        agentTitle: (agentMetadata.title as string) || agent.description,
        objective: agent.objective,
        runInput: queuedExecution?.input ?? { prompt: data.input },
        output,
      }))
      .catch((error) => apiLogger.warn('agent knowledge capture failed', {
        executionId: execution.id,
        error: error instanceof Error ? error.message : String(error),
      }))
    // Post-run reflection (WS1.9): distill learnings + critique + suggestions.
    // Chained before graph indexing enrichment is NOT needed — indexExecution
    // already ran; reflection memories are graph-indexed via their own path in
    // plan 2. Fire-and-forget: never blocks or fails the run.
    void reflectAndRemember({
      organizationId,
      agentId: agent.id,
      executionId: execution.id,
      goal: linkedGoalContext ?? (agent as { goal?: string | null }).goal ?? null,
      objective: agent.objective,
      summary,
      processLog: transcriptSummaryForReflection(transcript),
      planFindings,
      recordSuggestionEvent: (payload) => recordEvent(execution.id, null, 'agent.suggestion', payload),
      userId: agent.userId ?? userId,
      model,
      integrations: providers,
      category: typeof agentMetadata.category === 'string' ? agentMetadata.category : undefined,
      runSucceeded: true,
    })
      .then(async (reflection) => {
        // Run→goal contribution: persist the verdict against each linked goal
        // and escalate stalls. Chained after reflection because the verdict IS
        // reflection output; still fire-and-forget relative to the run.
        if (!reflection) return
        const { recordGoalRunVerdicts } = await import('@/lib/goals/verdicts')
        await recordGoalRunVerdicts({
          organizationId,
          resourceType: 'agent',
          resourceId: agent.id,
          runId: execution.id,
          verdict: reflection.goalContribution.verdict,
          evidence: reflection.goalContribution.evidence,
          ...(groundedGoalIds ? { goalIds: groundedGoalIds } : {}),
        })
      })
      .catch(() => undefined)
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
          sourceRunId: execution.id,
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
    // Status-guarded: a row the reaper already failed (or a cancel already
    // finalized) keeps its terminal state; skip the duplicate error
    // notification in that case, but still rethrow so BullMQ dead-letters.
    // systemPrisma: id-keyed terminal write on worker job data; execution id was
    // validated against this tenant when execution was loaded/created above.
    const failureClaim = await systemPrisma.agentExecution.updateMany({
      where: { id: execution.id, status: { in: ['pending', 'running', 'waiting_for_input', 'waiting_for_approval'] } },
      data: {
        status: 'failed',
        // M5 — cap persisted error strings so they can't bloat the row.
        error: message.slice(0, 300),
        transcript: jsonValue(encryptRunValue(transcript)),
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        executionTime: { increment: Date.now() - segmentStart },
        completedAt: new Date(),
      },
    })
    if (failureClaim.count === 0) throw error
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
    // Cross-tool ledger flush on the FAILURE path too. Without this, the
    // ledger only ever sees integrations from runs that worked, and any
    // aggregate built on it is survivorship-biased by construction.
    await recordToolCallEvents({
      organizationId,
      userId,
      executionId: execution.id,
      touched: touchedTools,
      succeeded: false,
    }).catch(() => undefined)
    throw error
  }
}

export async function executeAgentJob(job: Job<AgentExecutionJob>) {
  return runAgentExecution(job.data)
}
