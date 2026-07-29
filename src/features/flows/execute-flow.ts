import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { flowJobOptions } from '@/lib/flows/queue-options'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { isWriteProvider } from '@/lib/connectors/registry'
import { notify } from '@/lib/notifications/service'
import { recordAudit } from '@/lib/audit'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { ApiError } from '@/lib/server/api-handler'
import { triggerFromGraph, triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { stepLabelsOf } from '@/lib/flows/token-text'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
import { shouldReuseInput, storedRunInput } from '@/lib/flows/reuse-input'
import { interpretFlow, type RunAgentFn, type RunActionFn, type RunCodeFn, type RunFlowFn, type RouteAiFn } from './interpret'
import { runJavaScript } from '@/lib/code/run-js'
import { resolveResumeState } from './resume-scan'
import { buildRouterPrompt, routerBranchSchema, parseRouterChoice } from '@/lib/flows/router'
import { generateStructured, generateText } from '@/lib/llm/model-runner'
import { flowActionRetries, flowActionTimeoutMs, runWithRetries, shouldRetryAfterTimeout } from './action-reliability'
import { performHttpRequest, prepareHttpRequest, redactHttpStepInput, withBearerAuthorization } from './http'
import { resolveHttpConnectionToken } from './http-auth'
import { resolveHttpCredential } from '@/lib/credentials/resolve'
import { applyCredentialPlan } from '@/lib/credentials/apply'
import { shouldPersistInterpreterStep } from './run-step-persistence'
import { prepareToolArgs } from './tool-args'
import { flowToolOutput } from './tool-output'
import { slackOriginOf } from '@/lib/slack/reply'
import { deliverSlackRunReply } from '@/lib/slack/deliver'
import { apiLogger } from '@/lib/logger'
import { recordToolCallEvents } from '@/lib/behavior/record-event'
import { credentialVerificationKey } from '@/lib/connections/verification'
import { recordVerificationAsync } from '@/lib/connections/record-verification'

export type FlowExecutionJob = {
  flowId: string
  organizationId: string
  userId: string
  input?: unknown
  flowRunId?: string
  // Resume a paused run: the user's reply to the ask-user step that paused it.
  reply?: string
  /** Scheduler-driven resume for a durable Wait node. */
  resumeReason?: 'time'
  /** Draft-test partial execution controls. Never used by external triggers. */
  startNodeId?: string
  /** Builder single-node test: execute ONLY this node (never downstream). */
  onlyNodeId?: string
  mockOutputs?: Record<string, unknown>
  // Queue mode only: dispatchFlowExecution pre-created this FlowRun row (so
  // the caller has an id to poll) — adopt it instead of creating a new one.
  // Distinct from flowRunId, which always means "resume a waiting run".
  queuedRunId?: string
  // Scheduled/triggered runs execute the PUBLISHED graph; a manual builder run
  // executes the working draft so you can test before publishing.
  usePublished?: boolean
  // How this run was started — persisted on the FlowRun for provenance.
  trigger?: { type: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack' | 'activity' | 'node_test'; [key: string]: unknown }
  // Synchronous subflow nesting depth — bounds runaway flow->flow recursion.
  subflowDepth?: number
  errorDepth?: number
  // Slack multi-turn: a prior AgentExecution id whose transcript seeds the
  // FIRST saved-agent step of this run (execution order), so a thread carries
  // one conversation across runs. Consumed at most once per run.
  slackContinueExecutionId?: string
}

// Bound HTTP responses so downstream prompts/logs stay manageable.
const HTTP_MAX_RESPONSE_CHARS = 50_000
// Synchronous subflow nesting: a flow calling a flow calling a flow... is
// refused past this depth to bound runaway recursion (e.g. a flow that
// subflows itself).
const MAX_SUBFLOW_DEPTH = 5

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Slack multi-turn seed resolution: given the loop-thread's own continuation
 * candidate for this node (if any) and this run's remaining Slack-seed state,
 * decide the `continueExecutionId` for THIS agent invocation, and whether it
 * consumes the run-scoped Slack seed latch.
 *
 * Pulled out of the `runAgent` adapter as a pure function so the "seeds
 * EXACTLY the first agent step, ONCE" and "a loop-thread agent is NEVER
 * hijacked" invariants are unit-testable without a live LLM call — the
 * adapter below calls this exact function, it is not a parallel
 * reimplementation.
 */
export function resolveAgentContinueExecutionId(args: {
  // The loop-thread continuation id for this exact node, if any (already
  // resolved from `threadExecutions` — iteration 0 has none).
  threadContinueExecutionId?: string
  // True when this agent node sits inside a threaded loop iteration (whether
  // or not iteration 0 produced a threadContinueExecutionId yet).
  hasThread: boolean
  // True anywhere inside a threadAgent loop's body, INCLUDING through a
  // container (parallel branch / nested loop / errorShield) that does not
  // itself carry `thread` (see FlowContext.withinThreadedLoop). An agent here
  // must never be seeded from an unrelated Slack-continuation run — the
  // loop-thread's own (sequential) continuation is the only conversation this
  // agent may continue, and only `hasThread`/`threadContinueExecutionId`
  // decide that. This flag exists purely to CLOSE that hijack; it changes no
  // other behavior.
  withinThreadedLoop: boolean
  // True when this invocation is re-entering a paused agent execution.
  isResume: boolean
  // Run-scoped latch: true until some earlier ELIGIBLE step has consumed it.
  slackSeedRemaining: boolean
  slackContinueExecutionId?: string
}): { continueExecutionId?: string; consumed: boolean } {
  if (args.threadContinueExecutionId) return { continueExecutionId: args.threadContinueExecutionId, consumed: false }
  if (
    !args.hasThread &&
    !args.withinThreadedLoop &&
    !args.isResume &&
    args.slackSeedRemaining &&
    args.slackContinueExecutionId
  ) {
    return { continueExecutionId: args.slackContinueExecutionId, consumed: true }
  }
  return { continueExecutionId: undefined, consumed: false }
}

/**
 * Terminalize a child FlowRun that a SYNCHRONOUS parent (a subflow node or a
 * flow-as-tool call) abandoned while the child was paused. Subflows/flow-tools
 * are synchronous-only in v1: the parent already recorded a clean failure, so
 * the child must not linger. The reaper only sweeps `running`, so a `waiting`
 * child would otherwise persist forever and re-run its side effects (real
 * writes, flow.completed) if a human resumed it. Mark it failed.
 * Best-effort — never throws into the parent.
 */
export async function terminalizeAbandonedChildRun(organizationId: string, childFlowRunId: string): Promise<void> {
  try {
    await prisma.flowRun.updateMany({
      where: { id: childFlowRunId, organizationId, status: 'waiting' },
      data: {
        status: 'failed',
        error: 'Abandoned — the parent subflow / flow-tool call does not support pausing for human input.',
        finishedAt: new Date(),
      },
    })
  } catch {
    // best-effort: terminalization failure must never mask the primary error.
  }
}

/**
 * Run a flow to completion. Each agent node delegates to the real agent runtime
 * (runAgentExecution) and is recorded as a FlowRunStep so the builder canvas can
 * poll live per-step status. Returns the terminal run status + output.
 */
export async function runFlowExecution(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown; error?: string; logs?: string[]; waiting?: { nodeId: string; question?: string; wakeAt?: string }; webhookResponse?: { statusCode: number; headers: Record<string, string>; bodyMode: 'json' | 'text' | 'binary' | 'none'; body?: unknown } }> {
  const flow = await prisma.flow.findFirst({ where: { id: job.flowId, organizationId: job.organizationId } })
  if (!flow) throw new Error('Flow not found')
  if ((job.subflowDepth ?? 0) > MAX_SUBFLOW_DEPTH) {
    throw new ApiError('Subflow nesting is too deep.', 400, 'SUBFLOW_DEPTH_EXCEEDED')
  }
  const resuming = Boolean(job.flowRunId && (job.reply !== undefined || job.resumeReason === 'time'))
  // Cross-tool ledger (behavior spec §2): providers this run's tool steps
  // touched, deduped to one tool_call event per (run segment, provider).
  const touchedTools = new Map<string, Set<string>>()

  // Resume: atomically claim the run — only a genuinely `waiting` run may be
  // resumed. A concurrent resume, a run the reaper already terminalized, or a
  // duplicate reply delivery all lose cleanly here instead of re-interpreting
  // an already-moving or already-dead run. Mirrors execute-agent.ts's
  // waiting -> running atomic claim. Refresh startedAt so reapStuckFlowRuns
  // does not mark the run failed the moment it is legitimately resumed after
  // a long pause.
  let existingRun: Awaited<ReturnType<typeof prisma.flowRun.findFirst>> = null
  if (resuming) {
    const claimed = await prisma.flowRun.updateMany({
      where: { id: job.flowRunId, organizationId: job.organizationId, status: 'waiting' },
      data: { status: 'running', startedAt: new Date() },
    })
    if (claimed.count === 0) throw new ApiError('This run is not waiting for input', 409, 'FLOW_RUN_NOT_WAITING')
  }
  // Snapshot pinning: a resumed run executes the EXACT graph it started with
  // (graphSnapshot), never whatever the flow currently is — a publish made
  // while the run waited must not reshape a run already in flight.
  //
  // Invariant: once the claim above flips a run to `running`, the read-only
  // preparation up to and including graph validation is wrapped so that any
  // throw here — a deleted agent/connection the snapshot still references, a
  // malformed snapshot, graph validation failure — rolls the run back to
  // `waiting` before rethrowing. Otherwise the run would be stuck `running`
  // with no executor, and the user's reply would be unretryable until the
  // reaper terminalizes it after 30 minutes. The later resume-state block
  // (marking the waiting step resumed) sits
  // OUTSIDE this wrap: those writes are destructive, so a blind rollback
  // could not restore them anyway — a throw there strands the run until the
  // reaper sweeps it (rare: plain DB writes). Once interpretFlow begins,
  // failures are handled by the existing failure paths (run marked `failed`)
  // — this rollback must not extend into that phase.
  let graph!: ReturnType<typeof flowGraphSchema.parse>
  // Node-id → display-label map (agent titles resolved from the loaded agents),
  // threaded into the interpreter so `{{<Node label>.output...}}` references
  // resolve to the same label the builder shows on token chips.
  let stepLabels: Record<string, string> = {}
  try {
    if (resuming) {
      existingRun = await prisma.flowRun.findFirst({ where: { id: job.flowRunId, organizationId: job.organizationId } })
      if (!existingRun) throw new Error('Flow run not found after claim')
    }
    // Legacy fallback: a pre-snapshot waiting run (graphSnapshot null) resumes
    // against the flow's current graph — the same source a fresh run would use.
    const currentGraph = job.usePublished && flow.publishedGraph != null ? flow.publishedGraph : flow.graph
    const source = existingRun ? existingRun.graphSnapshot ?? currentGraph : currentGraph
    graph = flowGraphSchema.parse(source)
    const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
      node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
    ).filter((id): id is string => Boolean(id))))
    const [agents, toolCatalog] = await Promise.all([
      prisma.agentTask.findMany({
        where: { organizationId: job.organizationId, status: 'ACTIVE' },
        select: { id: true, description: true },
        take: 500,
      }),
      usedConnectionIds.length
        // resource: without it the goals plane is skipped entirely (see
        // loadNativePlaneGroups), so a flow linked to a goal could never read
        // its pace or record the work it did toward it.
        ? loadFlowToolCatalog(job.organizationId, {
            userId: job.userId,
            connectionIds: usedConnectionIds,
            takeConnections: usedConnectionIds.length,
            resource: { type: 'flow', id: job.flowId },
          })
        : Promise.resolve([]),
    ])
    const validation = validateFlowGraph(graph, {
      agents: agents.map((agent) => ({ id: agent.id, title: agent.description })),
      toolCatalog,
    })
    // Single-node test: only THIS node's errors block. A half-built step
    // elsewhere in the draft must not stop the user testing the step they just
    // finished — "run the whole flow to learn anything" is the exact friction
    // this mode removes. Full runs keep whole-graph validation.
    const blockingErrors = job.onlyNodeId
      ? validation.errors.filter((issue) => issue.nodeId === job.onlyNodeId)
      : validation.errors
    if (blockingErrors.length > 0) {
      throw new ApiError(
        validationErrorMessage({ ...validation, ok: false, errors: blockingErrors }),
        400,
        'FLOW_VALIDATION_ERROR',
      )
    }
    stepLabels = stepLabelsOf(graph, agents.map((agent) => ({ id: agent.id, title: agent.description })))
  } catch (error) {
    // The `status: 'running'` guard means we only roll back a claim we
    // ourselves hold — never stomp a reaper's terminal `failed` write.
    if (resuming) {
      await prisma.flowRun.updateMany({
        where: { id: job.flowRunId, organizationId: job.organizationId, status: 'running' },
        data: { status: 'waiting' },
      })
    }
    throw error
  }
  let input: unknown = job.input ?? ''

  // Required trigger inputs (declared on the trigger node) must be present.
  // Skipped when resuming: the original input was validated on the first run.
  // Input memory: before failing on missing fields, fall back to the last
  // successful run's input — but only when the flow hasn't been edited since
  // that run started (shouldReuseInput), so an edited flow always demands
  // fresh input. A run that supplies every required field never falls back:
  // deliberately different-but-complete input always wins.
  let reusedInput = false
  if (!resuming) {
    const inputFields = triggerInputFieldsFromTrigger(triggerFromGraph(graph, flow.trigger))
    let missing = missingRequiredInputFields(inputFields, input)
    if (missing.length) {
      const lastSuccess = await prisma.flowRun.findFirst({
        where: { flowId: flow.id, organizationId: job.organizationId, status: 'succeeded' },
        orderBy: { startedAt: 'desc' },
        select: { input: true, startedAt: true },
      })
      if (lastSuccess && shouldReuseInput({ flowUpdatedAt: flow.updatedAt, lastSuccessStartedAt: lastSuccess.startedAt })) {
        const candidate = storedRunInput(lastSuccess.input)
        if (!missingRequiredInputFields(inputFields, candidate).length) {
          input = candidate
          reusedInput = true
          missing = []
        }
      }
    }
    if (missing.length) {
      throw new ApiError(
        `Missing required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
        400,
        'FLOW_INPUT_ERROR',
      )
    }
  }
  // Queue mode: adopt the row dispatchFlowExecution pre-created instead of
  // minting a second one. Status-guarded on 'running' — if the reaper already
  // terminalized a stale pre-created row, adoption loses cleanly and the job
  // dead-letters rather than re-running against a settled row.
  let adoptedRun: typeof existingRun = null
  if (!existingRun && job.queuedRunId) {
    const adopted = await prisma.flowRun.updateMany({
      where: { id: job.queuedRunId, organizationId: job.organizationId, flowId: flow.id, status: 'running' },
      data: {
        input: jsonValue({ prompt: input }),
        trigger: jsonValue({ ...(job.trigger ?? { type: 'manual' }), ...(reusedInput ? { reusedInput: true } : {}) }),
        graphSnapshot: jsonValue(graph),
        startedAt: new Date(),
      },
    })
    if (adopted.count === 0) throw new Error('Queued flow run not found or already settled')
    adoptedRun = await prisma.flowRun.findFirst({ where: { id: job.queuedRunId, organizationId: job.organizationId } })
    if (!adoptedRun) throw new Error('Queued flow run not found after adoption')
  }
  const run = existingRun ?? adoptedRun ?? await prisma.flowRun.create({
    data: {
      flowId: flow.id,
      status: 'running',
      input: jsonValue({ prompt: input }),
      // reusedInput marks the run as replaying the last successful input —
      // the run panel surfaces it so replayed payloads are never silent.
      trigger: jsonValue({ ...(job.trigger ?? { type: 'manual' }), ...(reusedInput ? { reusedInput: true } : {}) }),
      graphSnapshot: jsonValue(graph),
      organizationId: job.organizationId,
      userId: job.userId,
    },
  })
  // Resume integrity: a resume request carries the user's reply, not the run
  // input, so `input` re-derives as '' here — downstream `Run input` tokens
  // would resolve empty. Reload the original input persisted on the run row.
  // Guard: an explicit non-empty input passed alongside a resume still wins
  // (an unlikely caller override — the execute route never sends one).
  if (resuming && (input == null || input === '')) {
    input = storedRunInput(run.input) ?? ''
  }

  // Built before the resume scan below (as well as used by onStep further
  // down) so the scan can tell a container node's own 'waiting' row apart
  // from an inner leaf's — see resolveResumeState.
  const nodeTypeById = new Map(graph.nodes.map((node) => [node.id, node.type]))

  // Resume state: nodes that already succeeded are skipped (reusing their
  // stored output); the paused step is re-run with the reply injected.
  let completed: Record<string, unknown> = {}
  let resumeNodeId: string | undefined
  let resumeExecutionId: string | undefined
  let resumeKey: string | undefined
  let resumeChildFlowRunId: string | undefined
  let order = 0
  if (resuming) {
    const priorSteps = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id }, orderBy: { order: 'asc' } })
    ;({ completed, resumeNodeId, resumeExecutionId, resumeKey, resumeChildFlowRunId } = resolveResumeState(priorSteps, nodeTypeById))
    // Resuming creates NEW step rows for the re-run node — resolve every stale
    // waiting row now so it can never shadow a later pause in deriveRunWaiting,
    // and continue the order counter after all prior rows so new steps always
    // sort after old ones.
    await prisma.flowRunStep.updateMany({
      where: { flowRunId: run.id, status: 'waiting' },
      data: { status: 'resumed', finishedAt: new Date() },
    })
    if (priorSteps.length) order = Math.max(...priorSteps.map((step) => step.order)) + 1
  }

  // Container (condition/loop/parallel/stop) outcomes are reported via onStep;
  // persist them so runs are fully inspectable. Agent/tool/http steps are
  // persisted by their adapters because they need started/running rows.
  const pending: Promise<unknown>[] = []
  // Code steps' captured print()/console.log() lines, keyed by node — surfaced
  // on the run result for the single-node test path (the NDV's Logs section).
  const stepLogs: Record<string, string[]> = {}
  const onStep = (outcome: { nodeId: string; status: string; output?: unknown; error?: string; logs?: string[]; iterationPath?: number[] }) => {
    if (outcome.logs?.length) stepLogs[outcome.nodeId] = outcome.logs
    if (!shouldPersistInterpreterStep(nodeTypeById.get(outcome.nodeId))) return
    pending.push(
      prisma.flowRunStep
        .create({
          data: {
            flowRunId: run.id,
            nodeId: outcome.nodeId,
            order: order++,
            status: outcome.status,
            output: jsonValue(outcome.output ?? null),
            error: outcome.error ? outcome.error.slice(0, 300) : null,
            iterationPath: outcome.iterationPath?.length ? outcome.iterationPath.join('.') : null,
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined),
    )
  }

  // Loop-thread: the most-recent execution id per (loop, agent-node) thread, so
  // each iteration seeds its conversation from the previous one.
  const threadExecutions = new Map<string, string>()

  // Slack multi-turn seed — consumed by the first saved-agent invocation that
  // is neither loop-threaded nor a resume. Inline-prompt agents early-return
  // before the seed point and never consume it (documented limitation: with
  // parallel branches "first" is race-ordered).
  let slackSeedRemaining = Boolean(job.slackContinueExecutionId)

  // Adapter: each agent node runs the real agent and records a FlowRunStep row.
  const runAgent: RunAgentFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: order++,
        status: 'running',
        input: { prompt: node.input },
        iterationPath: node.iterationPath?.length ? node.iterationPath.join('.') : null,
        startedAt: new Date(),
      },
    })
    // Terminal writes below target this row ONLY while it is still 'running'.
    // A step timeout makes the interpreter abandon this promise and the
    // end-of-run sweep closes the row as failed; if the abandoned agent later
    // finishes, its late write must not resurrect the swept row inside a
    // failed run — the sweep is authoritative.
    const finishStep = async (data: Record<string, unknown>) => {
      await prisma.flowRunStep.updateMany({ where: { id: step.id, status: 'running' }, data })
    }
    // Link the agent execution to this step row the moment the execution row
    // exists (not only at the end of the run), so the runs panel can follow
    // the agent's live process events while the step is still running.
    // Best-effort write — the end-of-run updates below remain authoritative
    // (idempotent overwrite of the same id).
    const onExecutionCreated = (executionId: string) => {
      void prisma.flowRunStep
        .update({ where: { id: step.id }, data: { agentExecutionId: executionId } })
        .catch(() => undefined)
    }
    try {
      // Inline-prompt agent: a direct one-shot model call, no saved AgentTask.
      // (runAgentExecution requires an ACTIVE AgentTask and cannot run a
      // prompt-only ephemeral agent — see the design note.)
      if (!node.agentId?.trim()) {
        const text = await generateText({ system: node.prompt ?? '', user: node.input, model: node.model })
        await finishStep({ status: 'succeeded', output: jsonValue(text), finishedAt: new Date() })
        return { output: text }
      }
      // Resuming this node? Re-enter the paused agent execution with the reply.
      // `node.resume` is already key-matched to the exact iteration that
      // paused (interpretFlow computes it from `resumeKey`, not a bare
      // nodeId) — trust it here rather than re-deriving a bare-id match,
      // which would (as it once did) re-match EVERY not-yet-completed
      // iteration of this node id, not just the one that paused.
      const resumeThis = node.resume && resumeExecutionId
      // Loop-thread (threadAgent): the prior iteration's execution id (if any)
      // seeds this run's transcript so the conversation carries forward.
      // Iteration 0 has no predecessor to continue, so it always starts fresh.
      const threadKey = node.thread ? `${node.thread.key}:${node.id}` : undefined
      const threadContinueExecutionId = threadKey && node.thread!.iteration > 0 ? threadExecutions.get(threadKey) : undefined
      // Slack multi-turn: seed ONLY the first agent step reached in this run,
      // and never when loop-threading already provides a seed or this
      // invocation resumes a paused execution.
      const slackSeed = resolveAgentContinueExecutionId({
        threadContinueExecutionId,
        hasThread: Boolean(node.thread),
        withinThreadedLoop: node.withinThreadedLoop === true,
        isResume: Boolean(resumeThis),
        slackSeedRemaining,
        slackContinueExecutionId: job.slackContinueExecutionId,
      })
      const continueExecutionId = slackSeed.continueExecutionId
      if (slackSeed.consumed) slackSeedRemaining = false
      const result = (await runAgentExecution(
        resumeThis
          ? { agentId: node.agentId, organizationId: job.organizationId, userId: job.userId, executionId: resumeExecutionId, resume: true, reply: job.reply, onExecutionCreated }
          : { agentId: node.agentId, organizationId: job.organizationId, userId: job.userId, input: node.input, onExecutionCreated, ...(continueExecutionId ? { continueExecutionId } : {}) },
      )) as { summary?: string; status?: string; question?: string; executionId?: string }

      // Record this run's execution id as the next iteration's continuation
      // point (threading applies to SAVED agents only — an inline step returns
      // above via the `!node.agentId` early branch and never reaches here).
      // Only a COMPLETED execution may seed the next iteration. A waiting_*
      // execution's transcript ends on an unresolved tool_use, so continuing
      // from it would emit an invalid assistant(tool_use)->user request.
      const settledWaiting = typeof result?.status === 'string' && result.status.startsWith('waiting')
      if (threadKey && result.executionId && !settledWaiting) threadExecutions.set(threadKey, result.executionId)

      if (typeof result?.status === 'string' && result.status.startsWith('waiting')) {
        // Persist the pause reason on the step so the runs API can surface it.
        // The resume scan only reuses output for succeeded/skipped steps, so
        // this waiting-info output never leaks into resumed step data.
        await finishStep({
          status: 'waiting',
          agentExecutionId: result.executionId ?? null,
          output: jsonValue({ waiting: { kind: 'input', question: result.question } }),
          finishedAt: new Date(),
        })
        return { waiting: { status: result.status, question: result.question } }
      }
      const output = result?.summary ?? ''
      await finishStep({ status: 'succeeded', output: jsonValue(output), agentExecutionId: result.executionId ?? null, finishedAt: new Date() })
      return { output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finishStep({ status: 'failed', error: message.slice(0, 300), finishedAt: new Date() })
      return { error: message }
    }
  }

  // Adapter: each subflow node runs the child flow and records a FlowRunStep
  // linking the child run. A child that PAUSES (ask-user / humanReview /
  // durable Wait) pauses the parent too: the step parks `waiting` carrying the
  // child run id, and a parent resume re-enters this node — forwarding the
  // user's reply (or the scheduler tick) into the child, then continuing with
  // the child's final output. Mirrors the runAgent adapter above.
  const runFlow: RunFlowFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: order++,
        status: 'running',
        input: jsonValue({ flowId: node.flowId, input: node.input }),
        iterationPath: node.iterationPath?.length ? node.iterationPath.join('.') : null,
        startedAt: new Date(),
      },
    })
    const finishStep = async (data: Record<string, unknown>) => {
      await prisma.flowRunStep.updateMany({ where: { id: step.id, status: 'running' }, data })
    }
    // Park the parent on this step: persist the child linkage + pause reason,
    // and hand the interpreter a `waiting` result so the whole run parks.
    // A time-kind child pause wakes the PARENT slightly after the child, so
    // the scheduler resumes the child first and the parent finds its result.
    const pauseOn = async (childFlowRunId: string, waiting: { question?: string; wakeAt?: string } | undefined) => {
      const parentWakeAt = waiting?.wakeAt
        ? new Date(new Date(waiting.wakeAt).getTime() + 60_000).toISOString()
        : undefined
      const kind = parentWakeAt ? 'time' : 'input'
      await finishStep({
        status: 'waiting',
        childFlowRunId,
        output: jsonValue({ waiting: { kind, question: waiting?.question, ...(parentWakeAt ? { wakeAt: parentWakeAt } : {}) } }),
        finishedAt: new Date(),
      })
      return { waiting: { question: waiting?.question, ...(parentWakeAt ? { wakeAt: parentWakeAt } : {}) } }
    }
    try {
      const resumeChild = node.resume ? resumeChildFlowRunId : undefined
      let res: Awaited<ReturnType<typeof runFlowExecution>>
      if (resumeChild) {
        // Re-entering a step that paused on a child run: settle from the
        // child's CURRENT state — it may have been resumed directly (its own
        // activity page / a humanReview assignee) while the parent waited.
        const child = await prisma.flowRun.findFirst({
          where: { id: resumeChild, flowId: node.flowId, organizationId: job.organizationId },
          select: { id: true, status: true, output: true, error: true },
        })
        if (!child) {
          const message = 'The paused subflow run no longer exists.'
          await finishStep({ status: 'failed', error: message, finishedAt: new Date() })
          return { error: message }
        }
        if (child.status === 'succeeded') {
          res = { flowRunId: child.id, status: 'succeeded', output: child.output }
        } else if (child.status === 'failed') {
          res = { flowRunId: child.id, status: 'failed', output: null, error: child.error ?? 'The subflow failed.' }
        } else if (child.status === 'waiting') {
          // Forward the reply (or the scheduler tick) into the paused child.
          res = await runFlowExecution({
            flowId: node.flowId,
            organizationId: job.organizationId,
            userId: job.userId,
            flowRunId: child.id,
            reply: job.reply,
            resumeReason: job.resumeReason,
            usePublished: true,
            trigger: { type: 'signal', via: 'subflow' },
            subflowDepth: (job.subflowDepth ?? 0) + 1,
          })
        } else {
          // 'running': a concurrent resume owns the child — park again and let
          // the scheduler re-check shortly rather than double-driving it.
          return await pauseOn(child.id, { wakeAt: new Date(Date.now() + 60_000).toISOString() })
        }
      } else {
        res = await runFlowExecution({
          flowId: node.flowId,
          organizationId: job.organizationId,
          userId: job.userId,
          input: node.input,
          usePublished: true,
          trigger: { type: 'signal', via: 'subflow' },
          subflowDepth: (job.subflowDepth ?? 0) + 1,
        })
      }
      if (res.status === 'waiting') {
        return await pauseOn(res.flowRunId, res.waiting)
      }
      if (res.status === 'failed') {
        const message = res.error ?? 'The subflow failed.'
        await finishStep({ status: 'failed', childFlowRunId: res.flowRunId, error: message, finishedAt: new Date() })
        return { error: message }
      }
      await finishStep({ status: 'succeeded', childFlowRunId: res.flowRunId, output: jsonValue(res.output), finishedAt: new Date() })
      return { output: res.output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finishStep({ status: 'failed', error: message.slice(0, 300), finishedAt: new Date() })
      return { error: message }
    }
  }

  // Code steps: dispatch to the language engine. Step rows are persisted by
  // the generic interpreter onStep path (shouldPersistInterpreterStep), so
  // this adapter only runs the code. run-python is imported lazily — its
  // engine is Pyodide, and merely warming that module costs nothing until a
  // Python step actually executes.
  const runCode: RunCodeFn = async (params) => {
    if (params.language === 'python') {
      const { runPython } = await import('@/lib/code/run-python')
      return runPython(params)
    }
    return runJavaScript(params)
  }

  // Deterministic steps: MCP tool calls and HTTP requests. Same FlowRunStep
  // bookkeeping as agent steps so the run panel shows their input/output.
  const runAction: RunActionFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: order++,
        status: 'running',
        // Persisted request details must never contain credentials: an http
        // step's Authorization header value is replaced with 'redacted'.
        input: jsonValue(node.kind === 'http' ? redactHttpStepInput(node.config) : node.config),
        iterationPath: node.iterationPath?.length ? node.iterationPath.join('.') : null,
        startedAt: new Date(),
      },
    })
    // Conditional on 'running' for the same reason as agent steps: the
    // end-of-run failure sweep is authoritative over any late adapter write.
    const finish = async (patch: { status: string; output?: unknown; error?: string }) => {
      await prisma.flowRunStep.updateMany({
        where: { id: step.id, status: 'running' },
        data: {
          status: patch.status,
          output: patch.output !== undefined ? jsonValue(patch.output) : undefined,
          error: patch.error ? patch.error.slice(0, 300) : undefined,
          finishedAt: new Date(),
        },
      })
    }
    try {
      if (node.kind === 'tool') {
        // Tool steps route by connection-id prefix to the right tool plane
        // (MCP / native / Nango) — the same planes and
        // executors the agent runtime uses. See @/lib/flows/tool-connection-id.
        const connectionId = String(node.config.connectionId || '')
        const { plane, ref } = parseFlowToolConnectionId(connectionId)
        const toolName = String(node.config.toolName)

        const args = prepareToolArgs(node.config.args)
        const executor = await resolveFlowToolExecutor({
          organizationId: job.organizationId,
          userId: job.userId,
          plane,
          ref,
          toolName,
          // The goals plane scopes itself to the goals THIS resource is linked
          // to, so the executor needs to know which flow is running.
          resource: { type: 'flow', id: job.flowId },
        })

        const retries = flowActionRetries(node.config.retries)
        const timeoutMs = flowActionTimeoutMs(node.config.timeoutMs)
        // retryOnTimeout=false: a timed-out tool call is only abandoned, not
        // cancelled — the write may still land, so retrying could execute the
        // side effect twice. Hard errors keep the retry budget. (HTTP steps
        // below abort the request on timeout, so they may retry.)
        const output = await runWithRetries(
          async () => flowToolOutput(await executor.execute(toolName, args)),
          {
            retries,
            timeoutMs,
            retryOnTimeout: shouldRetryAfterTimeout('tool'),
            timeoutMessage: timeoutMs
              ? `Tool ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s — the call may still be finishing in the background.`
              : undefined,
          },
        )
        // Immutable audit trail, mirroring the agent loop's tool execution:
        // every plane is recorded; write/delivery planes are the consequential
        // ones. Args are hashed by recordAudit, never stored raw.
        await recordAudit({
          organizationId: job.organizationId,
          executionId: run.id,
          actorUserId: job.userId,
          actorKind: 'agent',
          // Write classification derives from the connector registry
          // (isWriteProvider) — nango:*, slack, email, AND the http builtin —
          // shared with the agent loop instead of a drifting local regex.
          action: isWriteProvider(executor.provider) ? 'tool.write' : 'tool.call',
          tool: toolName,
          resourceType: executor.provider,
          payload: args,
        })
        const touched = touchedTools.get(executor.provider) ?? new Set<string>()
        touched.add(toolName)
        touchedTools.set(executor.provider, touched)
        await finish({ status: 'succeeded', output })
        return { output }
      }
      // http
      const request = prepareHttpRequest(node.config)
      // Optional connection auth: resolve a fresh token server-side and inject
      // it as the Authorization header — unless the user set their own, which
      // wins. The token lives only in the outbound request, never in the
      // persisted step input/output or logs.
      const httpConnectionId = typeof node.config.connectionId === 'string' ? node.config.connectionId.trim() : ''
      const httpCredentialId = typeof node.config.credentialId === 'string' ? node.config.credentialId.trim() : ''
      const httpAuthMode = typeof node.config.authMode === 'string' ? node.config.authMode : undefined
      // A vault credential wins over a predefined connection only when the node
      // explicitly says so; otherwise infer from whichever field is populated,
      // preserving every pre-vault graph's behaviour.
      const useGeneric = httpAuthMode === 'generic' || (!httpAuthMode && !httpConnectionId && Boolean(httpCredentialId))
      if (httpAuthMode !== 'none' && useGeneric && httpCredentialId) {
        const resolvedCredential = await resolveHttpCredential({
          credentialId: httpCredentialId,
          organizationId: job.organizationId,
          userId: job.userId,
          requestUrl: request.url,
          assertUrlAllowed: assertPublicUrl,
        })
        const applied = applyCredentialPlan(request.url, request.init.headers as Record<string, string>, resolvedCredential.plan)
        request.url = applied.url
        request.init.headers = applied.headers
        request.runtimeAuth = resolvedCredential.runtimeAuth
        // Names only — so an off-origin redirect can strip exactly what the
        // credential added, whatever header it chose to use.
        request.credentialHeaders = Object.keys(resolvedCredential.plan.headers ?? {})
      } else if (httpAuthMode !== 'none' && httpConnectionId) {
        const token = await resolveHttpConnectionToken({
          connectionId: httpConnectionId,
          organizationId: job.organizationId,
          userId: job.userId,
        })
        request.init.headers = withBearerAuthorization(request.init.headers as Record<string, string>, token)
      }
      const retries = flowActionRetries(node.config.retries)
      let output
      try {
        output = await runWithRetries(async () => {
          const controller = new AbortController()
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
          }, request.timeoutMs)
          try {
            // The whole request sequence (redirects, pagination, batch throttle)
            // lives in performHttpRequest so it's unit-testable; this wrapper
            // supplies the real fetch, SSRF guard, and per-attempt abort signal.
            return await performHttpRequest(request, node.config, {
              assertUrlAllowed: assertPublicUrl,
              signal: controller.signal,
              maxResponseChars: HTTP_MAX_RESPONSE_CHARS,
            })
          } catch (error) {
            if (timedOut) throw new Error(`HTTP request timed out after ${request.timeoutMs}ms`)
            throw error
          } finally {
            clearTimeout(timer)
          }
        }, { retries, retryDelayMs: typeof node.config.retryDelayMs === 'number' ? node.config.retryDelayMs : undefined })
        if (useGeneric && httpCredentialId) {
          recordVerificationAsync({
            organizationId: job.organizationId,
            connectionId: credentialVerificationKey(httpCredentialId),
            state: 'verified',
          })
        }
      } catch (error) {
        if (useGeneric && httpCredentialId) {
          recordVerificationAsync({
            organizationId: job.organizationId,
            connectionId: credentialVerificationKey(httpCredentialId),
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      }
      await finish({ status: 'succeeded', output })
      return { output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finish({ status: 'failed', error: message })
      return { error: message }
    }
  }

  // AI Router: a cheap, enum-constrained one-shot model call — NOT a full agent
  // run (no AgentExecution row, no tools/RAG). generateStructured already does
  // cross-provider fallback and JSON-schema-constrained output.
  const routeAi: RouteAiFn = async (node) => {
    try {
      const { system, user } = buildRouterPrompt(node.branches, node.instructions, node.input)
      const raw = await generateStructured({ system, user, schema: routerBranchSchema(node.branches), schemaName: 'router_choice', maxTokens: 64 })
      return parseRouterChoice(raw, node.branches)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Cooperative stop: the runs route flips the row to 'stopping'; the
  // interpreter polls this between node settlements and halts without
  // starting new work. Throttled so a many-node flow doesn't hammer the DB.
  let stopCheckedAt = 0
  let stopRequested = false
  const shouldStop = async () => {
    if (stopRequested) return true
    const now = Date.now()
    if (now - stopCheckedAt < 2000) return false
    stopCheckedAt = now
    const current = await prisma.flowRun.findFirst({
      where: { id: run.id, organizationId: job.organizationId },
      select: { status: true },
    })
    stopRequested = current?.status === 'stopping'
    return stopRequested
  }

  const result = await interpretFlow(graph, input, {
    runAgent,
    runAction,
    runCode,
    runFlow,
    routeAi,
    onStep,
    stepLabels,
    shouldStop,
    // resumeKey names the EXACT paused iteration (see resume-scan.ts) — the
    // interpreter's guards match on it, so dropping it here would silently
    // downgrade every loop resume to the bare-id fallback (reply lost).
    ...((resuming || job.mockOutputs) ? { completed: { ...(resuming ? completed : {}), ...(job.mockOutputs ?? {}) }, ...(resuming ? { resumeNodeId, resumeKey, resumeReply: job.reply } : {}) } : {}),
    ...(job.startNodeId ? { startNodeId: job.startNodeId } : {}),
    ...(job.onlyNodeId ? { onlyNodeId: job.onlyNodeId } : {}),
  })
  await Promise.all(pending) // ensure all container-step rows are written
  const status = result.status === 'succeeded' ? 'succeeded'
    : result.status === 'waiting' ? 'waiting'
    : result.status === 'stopped' ? 'stopped'
    : 'failed'
  // A failed run persists WHY it failed (e.g. the step-timeout message) — the
  // runs API surfaces FlowRun.error, so it must never stay null on failure.
  const runError = status === 'failed' ? (result.error ?? 'The flow failed.').slice(0, 300) : null
  await prisma.flowRun.update({
    where: { id: run.id, organizationId: job.organizationId },
    data: { status, output: jsonValue(result.output), error: runError, wakeAt: result.waiting?.wakeAt ? new Date(result.waiting.wakeAt) : null, webhookResponse: result.webhookResponse ? jsonValue(result.webhookResponse) : undefined, finishedAt: status === 'waiting' ? null : new Date() },
  })
  if (status === 'succeeded') {
    void import('@/lib/knowledge/capture')
      .then(({ captureFlowRunKnowledge }) => captureFlowRunKnowledge({
        organizationId: job.organizationId,
        userId: job.userId,
        flowId: flow.id,
        flowRunId: run.id,
        flowName: flow.name,
        trigger: run.trigger,
        runInput: input,
        output: result.output,
      }))
      .catch((error) => apiLogger.warn('flow knowledge capture failed', {
        flowRunId: run.id,
        error: error instanceof Error ? error.message : String(error),
      }))
  }
  // Cross-tool ledger flush: which integrations this segment's tool steps
  // touched, one event per provider. Fire-and-forget — never blocks the run.
  void recordToolCallEvents({
    organizationId: job.organizationId,
    userId: job.userId,
    executionId: run.id,
    touched: touchedTools,
    // The run's terminal verdict. 'waiting' and 'stopped' are not successes:
    // the segment did not deliver an outcome, and counting them as such would
    // inflate every integration that appears in long-paused flows.
    succeeded: status === 'succeeded',
  }).catch(() => undefined)
  // A humanReview ("Request information") pause has no adapter: its waiting
  // FlowRunStep row was persisted by the interpreter's onStep path (the
  // outcome carries `{ waiting: { kind: 'input', question } }`), so the only
  // side effect owed here is telling the assignee — or the run owner when no
  // assignee is set — that the flow is waiting on them. notify never throws
  // into the run.
  if (status === 'waiting' && result.waiting) {
    const waitingNode = graph.nodes.find((node) => node.id === result.waiting?.nodeId)
    if (waitingNode?.type === 'humanReview') {
      await notify({
        organizationId: job.organizationId,
        userId: waitingNode.data.assigneeUserId?.trim() || run.userId || job.userId,
        type: 'flow.needs_input',
        level: 'action',
        title: `Flow "${flow.name}" needs information`,
        body: result.waiting.question ? `${result.waiting.question} (run ${run.id})` : `Reply to continue the flow (run ${run.id})`,
        executionId: flow.id,
        link: `/flows/${flow.id}/activity`,
      })
    }
  }
  if (status === 'failed' || status === 'stopped') {
    // Sweep phantom 'running' rows: a timed-out agent step's adapter promise
    // was abandoned by the interpreter, so its FlowRunStep would stay stuck
    // 'running' forever. Close every such row for THIS run. The sweep wins
    // over the abandoned adapter: its terminal writes are conditional on the
    // row still being 'running' (finishStep/finish above), so a zombie
    // completion can never flip a swept step back inside a failed run.
    // A user-stopped run sweeps the same way, just labeled 'stopped' —
    // a stop is not a failure. Best-effort — sweep failure must not mask
    // the run's real outcome.
    await prisma.flowRunStep
      .updateMany({
        where: { flowRunId: run.id, status: 'running' },
        data: {
          status: status === 'stopped' ? 'stopped' : 'failed',
          error: runError ?? 'The flow stopped before this step finished.',
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined)
  }

  // Best-effort recursive-learning pass: repeated run evidence becomes a
  // reviewable builder suggestion; it never mutates the published graph.
  await import('@/lib/intelligence/reflect-flow-run')
    .then(({ reflectFlowRun }) => reflectFlowRun({ organizationId: job.organizationId, flowId: flow.id, flowRunId: run.id, graph, status, error: runError }))
    .catch((error) => apiLogger.warn('flow reflection failed', { flowRunId: run.id, error: error instanceof Error ? error.message : String(error) }))

  // Optional workflow-level error handler. It receives a structured failure
  // envelope, runs the published handler, and is depth-bounded to prevent
  // handler cycles from recursively dispatching forever.
  if (status === 'failed' && (job.errorDepth ?? 0) < 3) {
    const metadata = flow.metadata && typeof flow.metadata === 'object' && !Array.isArray(flow.metadata) ? flow.metadata as Record<string, unknown> : {}
    const errorFlowId = typeof metadata.errorFlowId === 'string' ? metadata.errorFlowId : ''
    if (errorFlowId && errorFlowId !== flow.id) {
      await dispatchFlowExecution({
        flowId: errorFlowId,
        organizationId: job.organizationId,
        userId: job.userId,
        input: { failedFlowId: flow.id, failedRunId: run.id, error: runError, originalInput: input },
        usePublished: true,
        trigger: { type: 'signal', signal: 'flow.failed', sourceFlowId: flow.id },
        errorDepth: (job.errorDepth ?? 0) + 1,
      }).catch((error) => apiLogger.error('flow error handler dispatch failed', { flowRunId: run.id, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  // Slack reply-to-origin: a run started from Slack reports its outcome back
  // to the originating channel/thread — succeeded output, a failure notice,
  // or the pending question when the run pauses (the multi-turn bridge).
  // run.trigger carries the origin (persisted at dispatch), so resumes reply
  // too. Fire-and-safe: a Slack outage must never affect the run's outcome.
  const slackOrigin = slackOriginOf(run.trigger)
  // No reply for user-stopped runs: the stop was a deliberate in-app action,
  // not an outcome the Slack originator is waiting on.
  if (slackOrigin && status !== 'stopped') {
    await deliverSlackRunReply({
      organizationId: job.organizationId,
      flowId: flow.id,
      flowRunId: run.id,
      status,
      output: result.output,
      error: runError,
      question: status === 'waiting' ? result.waiting?.question : undefined,
      origin: slackOrigin,
    }).catch((error) => {
      apiLogger.error('slack run reply failed', { flowRunId: run.id, error: error instanceof Error ? error.message : String(error) })
    })
  }

  // Fire the flow.completed signal for other flows listening in this org.
  // Dynamic import: signals.ts imports runFlowExecution statically (it fires
  // matched flows), so a static import here back to signals.ts would be a
  // cycle — this keeps the edge one-directional. Fire-and-forget: a signal
  // emit must never block or fail this run's completion.
  // PUBLISHED RUNS ONLY: a builder Test/Run of a draft must never chain real
  // production flows — only scheduled/webhook/signal (published) runs emit.
  if (status === 'succeeded' && job.usePublished) {
    void import('./signals')
      .then((signals) =>
        signals.emitFlowSignal({
          organizationId: job.organizationId,
          signal: 'flow.completed',
          payload: { flowId: flow.id, flowName: flow.name, output: result.output },
          sourceFlowId: flow.id,
          depth: signals.signalDepthOf(job.trigger) + 1,
        }),
      )
      .catch(() => undefined)
  }

  return {
    flowRunId: run.id,
    status,
    output: result.output,
    error: runError ?? undefined,
    // The tested node's print()/console.log() lines — only meaningful when
    // this run targeted a single node, which is when a caller reads them.
    logs: job.onlyNodeId ? stepLogs[job.onlyNodeId] : undefined,
    // Pause detail for callers that park on this run (the subflow adapter):
    // the question a reply must answer, or the wake time of a durable Wait.
    waiting: status === 'waiting' && result.waiting ? result.waiting : undefined,
    webhookResponse: result.webhookResponse,
  }
}

/**
 * Entry point for every flow-execution caller. In `inlineExecution` mode
 * (dev default, or EXECUTION_MODE=inline) this is identical to calling
 * `runFlowExecution` directly. In queue mode it enqueues onto BullMQ (stall
 * recovery + dead-letter):
 *   - resumes carry their flowRunId and are redelivery-safe via the atomic
 *     waiting→running claim;
 *   - fresh jobs pre-create the FlowRun row HERE (status running) so the
 *     caller always has an id to poll — the worker adopts it via queuedRunId
 *     (mirrors agents/[id]/execute's pre-created AgentExecution pattern).
 */
export async function dispatchFlowExecution(
  job: FlowExecutionJob,
  opts: { background?: boolean } = {},
): Promise<{ flowRunId: string; status: string; output: unknown; error?: string; logs?: string[]; waiting?: { nodeId: string; question?: string; wakeAt?: string }; webhookResponse?: { statusCode: number; headers: Record<string, string>; bodyMode: 'json' | 'text' | 'binary' | 'none'; body?: unknown } } | { queued: true; flowRunId: string }> {
  if (inlineExecution) {
    // `background` decouples a FRESH run from the caller's request even in inline
    // mode: the manual builder run must survive the user navigating away, so we
    // pre-create the row and run detached on this process's event loop instead
    // of awaiting inside the /execute request (which dies with it). Resumes keep
    // the awaited path — their atomic waiting→running claim can reject
    // (FLOW_RUN_NOT_WAITING / time), and that must surface to the
    // reply UI, not vanish into a detached promise. Queue mode already decouples
    // every run, so `background` is a no-op there.
    const resuming = Boolean(job.flowRunId && (job.reply !== undefined || job.resumeReason === 'time'))
    if (opts.background && !resuming) return runFlowExecutionDetached(job)
    return runFlowExecution(job)
  }
  if (!workersEnabled) throw new Error('Flow worker is disabled')

  const resuming = Boolean(job.flowRunId && (job.reply !== undefined || job.resumeReason === 'time'))
  if (resuming) {
    const queue = createQueue(QUEUE_NAMES.FLOW_EXECUTION)
    await queue.add('execute-flow', job, flowJobOptions(job.flowRunId))
    return { queued: true, flowRunId: job.flowRunId! }
  }

  const preCreated = await prisma.flowRun.create({
    data: {
      flowId: job.flowId,
      status: 'running',
      input: jsonValue({ prompt: job.input ?? '' }),
      trigger: jsonValue(job.trigger ?? { type: 'manual' }),
      organizationId: job.organizationId,
      userId: job.userId,
    },
  })
  try {
    const queue = createQueue(QUEUE_NAMES.FLOW_EXECUTION)
    await queue.add('execute-flow', { ...job, queuedRunId: preCreated.id }, flowJobOptions(undefined))
  } catch (error) {
    // Never leave a phantom 'running' row for a job that was never enqueued.
    await prisma.flowRun
      .updateMany({
        where: { id: preCreated.id, organizationId: job.organizationId, status: 'running' },
        data: { status: 'failed', error: 'Unable to queue flow execution', finishedAt: new Date() },
      })
      .catch(() => undefined)
    throw error
  }
  return { queued: true, flowRunId: preCreated.id }
}

/**
 * Inline-mode background run: pre-create the FlowRun row (so the caller gets an
 * id to poll and the run is recorded the instant it starts), then run it
 * detached so it continues on this process's event loop even after the HTTP
 * response is sent and the browser navigates away. Mirrors the queue-mode
 * pre-create + `queuedRunId` adoption path, but without a worker/Redis — so a
 * single `next dev` keeps flows running in the background.
 *
 * Unlike the queue path there is no BullMQ dead-letter to terminalize a job
 * that throws during setup (bad graph, adoption race), so the `.catch` closes
 * the pre-created row to `failed` itself — otherwise a setup-time throw would
 * strand it `running` until the 30-minute reaper. The `status: 'running'` guard
 * means this never stomps a terminal status the run already wrote.
 */
async function runFlowExecutionDetached(job: FlowExecutionJob): Promise<{ queued: true; flowRunId: string }> {
  const preCreated = await prisma.flowRun.create({
    data: {
      flowId: job.flowId,
      status: 'running',
      input: jsonValue({ prompt: job.input ?? '' }),
      trigger: jsonValue(job.trigger ?? { type: 'manual' }),
      organizationId: job.organizationId,
      userId: job.userId,
    },
  })
  void runFlowExecution({ ...job, queuedRunId: preCreated.id }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.flowRun
      .updateMany({
        where: { id: preCreated.id, organizationId: job.organizationId, status: 'running' },
        data: { status: 'failed', error: (message || 'The flow run failed to start.').slice(0, 300), finishedAt: new Date() },
      })
      .catch(() => undefined)
    apiLogger.error('detached flow run failed', { flowRunId: preCreated.id, error: message })
  })
  return { queued: true, flowRunId: preCreated.id }
}

/** BullMQ job handler — the worker calls this for each dequeued flow job. */
export async function executeFlowJob(job: Job<FlowExecutionJob>): Promise<{ flowRunId: string; status: string; output: unknown }> {
  return runFlowExecution(job.data)
}
