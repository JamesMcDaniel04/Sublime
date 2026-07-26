import type { FlowGraph, FlowNode, FlowEdge, VariableType } from '@/lib/flows/graph'
import { resolveTemplate, resolveTemplateValue, asStructured, evalCondition, evalClause, serializeUpstream, type FlowContext } from './context'
import { stepLabelsOf } from '@/lib/flows/token-text'
import { shouldRetryAfterTimeout } from './action-reliability'
import { structuredResponseInstruction, parseStructuredAgentOutput } from './agent-response'
import { runDataOp } from '@/lib/flows/data-ops'
import { resolveInputParams, bindOutputFields } from '@/lib/flows/io-nodes'
import type { RouterBranchSpec } from '@/lib/flows/router'
import { joinBranchOutputs } from '@/lib/flows/join'
import { completedKey, nodeIdOfCompletedKey } from './completed-key'

export type StepOutcome = {
  nodeId: string
  status: 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'stopped'
  output?: unknown
  error?: string
  /** Code steps: captured print()/console.log() lines, success or failure. */
  logs?: string[]
  // Present when this step ran inside a loop body — see FlowContext.iterationPath.
  iterationPath?: number[]
}
export type RunAgentResult = { output?: unknown; error?: string; waiting?: { status: string; question?: string } }
export type RunAgentFn = (node: { id: string; agentId: string; input: string; prompt?: string; model?: string; resume?: boolean; thread?: { key: string; iteration: number }; iterationPath?: number[]; withinThreadedLoop?: boolean }) => Promise<RunAgentResult>
// Deterministic (non-agent) steps: tool calls and HTTP requests. `config`
// arrives with every template already resolved against the flow context.
// `resume` marks the node a paused run is re-entering so the adapter can
// consume the reply instead of re-executing.
export type RunActionFn = (node: { id: string; kind: 'tool' | 'http'; config: Record<string, unknown>; resume?: boolean; iterationPath?: number[] }) => Promise<RunAgentResult>
// Code step: run user-authored JS/Python against the resolved item list.
// Injected (like runAgent) so the interpreter stays pure — the vm/pyodide
// engines live in lib/code and are wired by execute-flow / the test route.
export type CodeRunOutcome = { ok: true; output: unknown; logs: string[] } | { ok: false; error: string; logs: string[] }
export type RunCodeFn = (params: {
  id: string
  language: 'javascript' | 'python'
  code: string
  items: unknown[]
  item?: unknown
  timeoutMs?: number
}) => Promise<CodeRunOutcome>
// Subflow: run a child flow and block on its output. A child that pauses
// (ask-user / humanReview / durable Wait) pauses the PARENT too — the adapter
// returns `waiting` (with the child's question or wake time), the parent run
// parks, and a resume re-enters this node to forward the reply / check the
// child before continuing.
export type RunFlowResult = { output?: unknown; error?: string; waiting?: { question?: string; wakeAt?: string } }
export type RunFlowFn = (node: { id: string; flowId: string; input: unknown; resume?: boolean; iterationPath?: number[] }) => Promise<RunFlowResult>
// AI Router branch pick. Injected (like runAgent) so the interpreter stays
// pure: the execute-flow adapter wires this to a cheap generateStructured call.
export type RouteAiFn = (node: { id: string; branches: RouterBranchSpec[]; instructions?: string; input: string }) => Promise<{ branch: string } | { error: string }>
export type InterpretResult = {
  status: 'succeeded' | 'failed' | 'waiting' | 'stopped'
  steps: StepOutcome[]
  output: unknown
  waiting?: { nodeId: string; question?: string; wakeAt?: string }
  // Why a failed run failed — the failing node's error (e.g. the timeout
  // message) so callers can persist it on the run record.
  error?: string
  webhookResponse?: { statusCode: number; headers: Record<string, string>; bodyMode: 'json' | 'text' | 'binary' | 'none'; body?: unknown }
}

type Opts = {
  runAgent: RunAgentFn
  runAction?: RunActionFn
  runCode?: RunCodeFn
  runFlow?: RunFlowFn
  routeAi?: RouteAiFn
  maxSteps?: number
  maxLoopIterations?: number
  /**
   * Cap on how many independent DAG nodes execute at once. Nodes only run
   * concurrently when the graph actually branches — a linear flow is unaffected.
   */
  maxConcurrency?: number
  onStep?: (outcome: StepOutcome) => void
  /**
   * Cooperative cancellation: polled between node settlements. Returning true
   * halts admission of new nodes — in-flight nodes finish (nothing is killed
   * mid-write) and the run settles as `stopped`. The caller throttles any
   * expensive check (execute-flow polls the run row at most every ~2s).
   */
  shouldStop?: () => Promise<boolean> | boolean
  // Resume support: `completed` maps node ids already finished on a prior run to
  // their output (they are skipped, not re-run); `resumeNodeId` is the node that
  // was paused and should re-run with the user's reply injected.
  completed?: Record<string, unknown>
  resumeNodeId?: string
  // The resume target as a KEY (see completed-key.ts / resume-scan.ts):
  // `completedKey(resumeNodeId, resumeIterationPath)`. Every resume guard
  // compares THIS against `completedKey(node.id, ctx.iterationPath)` — never
  // the bare `resumeNodeId` — so a resume matches exactly the one iteration
  // that paused, not every not-yet-completed iteration of that node id. For a
  // non-loop pause this is byte-identical to `resumeNodeId` (bare id), so
  // normal (non-loop) pause/resume is unaffected. When omitted, guards fall
  // back to `resumeNodeId` as the key — identical for every non-loop node,
  // and a SAFE non-match (re-pause, never cross-wire) for loop-body nodes,
  // whose keys always carry an iteration path.
  resumeKey?: string
  // The user's reply for the resuming node. Agent steps receive the reply
  // inside their adapter (execute-flow re-enters the paused execution with
  // it); a humanReview step has no adapter, so the interpreter itself turns
  // this reply into the resuming step's output.
  resumeReply?: string
  // The webhook-derived payload for a webhook-triggered run — the secondary
  // source for input-node precedence (user > webhook > default). Absent for
  // manual/API/flow-as-tool runs, where the trigger input is the sole user source.
  webhookInput?: unknown
  /** Builder test mode: begin at this node, with upstream mock outputs in completed. */
  startNodeId?: string
  /**
   * Builder single-node test: execute ONLY this node. Upstream values come
   * from `completed` (seeded by the caller from pins / the last run).
   * Distinct from `startNodeId`, which begins here and continues downstream —
   * this must never fire a downstream write action.
   */
  onlyNodeId?: string
  // Node-id → display-label map (as the builder derives it, agent titles
  // included). Threaded onto the context so `{{<Node label>.output...}}`
  // references resolve. When omitted, the interpreter derives labels from the
  // graph alone (agent nodes without an explicit label fall back to a generic
  // name); execute-flow passes the agent-title-enriched map.
  stepLabels?: Record<string, string>
}

// Result of executing a single node — an output, or a control signal that
// propagates up through containers and halts the main chain.
type NodeResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'skip' }
  | { kind: 'stop' }
  | { kind: 'fail'; error: string }
  | { kind: 'pause'; nodeId: string; question?: string; wakeAt?: string }
  // A filter that didn't pass: drops the current loop item, or ends the main chain.
  | { kind: 'drop' }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Sentinel a timed-out race resolves to — distinguishable from a RunAgentResult
// that happens to carry an error.
const TIMED_OUT = Symbol('flow-step-timed-out')

/** Race `promise` against a deadline; the timer is cleared either way. */
const raceTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Convert common run-input shapes into a loopable list. */
function loopItems(value: unknown): unknown[] {
  const structured = asStructured(value)
  if (Array.isArray(structured)) return structured
  if (structured && typeof structured === 'object') {
    for (const key of ['items', 'records', 'results', 'data']) {
      const candidate = (structured as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) return candidate
    }
    return []
  }
  if (typeof structured !== 'string') return []
  const trimmed = structured.trim()
  if (!trimmed) return []
  const lines = trimmed.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const commaParts = trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  if (commaParts.length > 1) return commaParts
  return [trimmed]
}

// ── Variable steps: a typed symbol table shared across the whole run ────────

const VARIABLE_DEFAULTS: Record<VariableType, () => unknown> = {
  boolean: () => false,
  integer: () => 0,
  float: () => 0,
  string: () => '',
  object: () => ({}),
  array: () => [],
}

const asText = (value: unknown): string => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value))

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** The type family a variable's current runtime value belongs to. */
function runtimeTypeOf(value: unknown): VariableType {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float'
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return 'string'
}

/** Coerce a resolved value to a variable type. Blank values take the type's default. */
function coerceVariableValue(name: string, varType: VariableType, resolved: unknown): { value: unknown } | { error: string } {
  const text = typeof resolved === 'string' ? resolved.trim() : undefined
  if (resolved === undefined || text === '') return { value: VARIABLE_DEFAULTS[varType]() }
  switch (varType) {
    case 'boolean': {
      if (typeof resolved === 'boolean') return { value: resolved }
      if (text?.toLowerCase() === 'true') return { value: true }
      if (text?.toLowerCase() === 'false') return { value: false }
      return { error: `Variable "${name}" needs true or false — "${asText(resolved)}" isn't either.` }
    }
    case 'integer': {
      const n = typeof resolved === 'number' ? resolved : Number(text)
      if (Number.isInteger(n)) return { value: n }
      return { error: `Variable "${name}" needs a whole number — "${asText(resolved)}" isn't one.` }
    }
    case 'float': {
      const n = typeof resolved === 'number' ? resolved : Number(text)
      if (Number.isFinite(n)) return { value: n }
      return { error: `Variable "${name}" needs a number — "${asText(resolved)}" isn't one.` }
    }
    case 'string':
      return { value: typeof resolved === 'string' ? resolved : asText(resolved) }
    case 'object': {
      const parsed = typeof resolved === 'string' ? safeJson(text ?? '') : resolved
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed }
      return { error: `Variable "${name}" needs a JSON object value.` }
    }
    case 'array': {
      const parsed = typeof resolved === 'string' ? safeJson(text ?? '') : resolved
      if (Array.isArray(parsed)) return { value: parsed }
      return { error: `Variable "${name}" needs a JSON array value.` }
    }
  }
}

/**
 * Apply one variable step to the run's symbol table. Initialize coerces to the
 * declared type; set/increment coerce against the DECLARED type from the
 * variable's initialize node (so a float var stays float even while its current
 * value happens to be whole), falling back to the current value's runtime
 * family only when no initialize node exists; increment/decrement take an
 * optional templated amount (default 1); appends require the matching
 * array/string shape. Returns the variable's new value — the step's output —
 * or a plain-english error.
 */
function applyVariableOp(
  node: Extract<FlowNode, { type: 'variable' }>,
  ctx: FlowContext,
  declaredTypes: ReadonlyMap<string, VariableType>,
): { output: unknown } | { error: string } {
  const variables = (ctx.variables ??= {})
  const name = node.data.name.trim()
  if (!name) return { error: 'This variable step needs a name.' }
  if (node.data.op === 'initialize') {
    const resolved = node.data.value?.trim() ? resolveTemplateValue(node.data.value, ctx) : undefined
    const coerced = coerceVariableValue(name, node.data.varType ?? 'string', resolved)
    if ('error' in coerced) return coerced
    variables[name] = coerced.value
    return { output: coerced.value }
  }
  if (!Object.prototype.hasOwnProperty.call(variables, name)) {
    return { error: `Variable "${name}" hasn't been initialized yet.` }
  }
  const current = variables[name]
  const declared = declaredTypes.get(name) ?? runtimeTypeOf(current)
  if (node.data.op === 'set') {
    const raw = node.data.value ?? ''
    const resolved = resolveTemplateValue(raw, ctx)
    // A configured value (e.g. a token) that resolves to nothing is a broken
    // reference — fail instead of silently resetting to the type default. A
    // raw-empty field stays a legitimate "set to the default" (empty string,
    // empty object/array).
    const blank = resolved === undefined || (typeof resolved === 'string' && resolved.trim() === '')
    if (blank && raw.trim()) return { error: `Variable "${name}" needs a value — the value came back empty.` }
    const coerced = coerceVariableValue(name, declared, resolved)
    if ('error' in coerced) return coerced
    variables[name] = coerced.value
    return { output: coerced.value }
  }
  if (node.data.op === 'increment' || node.data.op === 'decrement') {
    const verb = node.data.op === 'increment' ? 'incremented' : 'decremented'
    if (typeof current !== 'number') return { error: `Variable "${name}" isn't a number, so it can't be ${verb}.` }
    let amount = 1
    if (node.data.value?.trim()) {
      const resolvedAmount = resolveTemplate(node.data.value, ctx).trim()
      // Number('') is 0 — a broken token amount must fail, not silently no-op.
      if (!resolvedAmount) return { error: `Variable "${name}" needs a number for the amount — the value came back empty.` }
      amount = Number(resolvedAmount)
      if (!Number.isFinite(amount)) return { error: `Variable "${name}" needs a number amount — "${resolvedAmount}" isn't one.` }
      if (declared === 'integer' && !Number.isInteger(amount)) {
        return { error: `Variable "${name}" needs a whole number amount — "${resolvedAmount}" isn't one.` }
      }
    }
    const next = node.data.op === 'increment' ? current + amount : current - amount
    variables[name] = next
    return { output: next }
  }
  if (node.data.op === 'appendArray') {
    if (!Array.isArray(current)) return { error: `Variable "${name}" isn't an array, so nothing can be appended.` }
    const next = [...current, resolveTemplateValue(node.data.value ?? '', ctx)]
    variables[name] = next
    return { output: next }
  }
  // appendString
  if (typeof current !== 'string') return { error: `Variable "${name}" isn't text, so nothing can be appended.` }
  const next = current + resolveTemplate(node.data.value ?? '', ctx)
  variables[name] = next
  return { output: next }
}

function resolveConfigValue(value: string | undefined, ctx: FlowContext): unknown {
  if (!value?.trim()) return undefined
  try {
    return resolveTemplateValue(JSON.parse(value), ctx)
  } catch {
    return resolveTemplateValue(value, ctx)
  }
}

const DEFAULT_AGENT_INPUTS = new Set(['{{trigger.input}}', 'Use this flow input:\n{{trigger.input}}'])

/**
 * Existing Agent nodes become Slack-bot handlers without a special node type:
 * when the node still has the builder's default/blank input and the trigger
 * payload is a normalized Slack message, feed the user's query text directly
 * to the agent. Explicit node input always wins, and non-Slack flow inputs keep
 * the existing template-resolution behavior.
 */
function agentInput(nodeInput: string | undefined, ctx: FlowContext): string {
  const template = nodeInput?.trim() || '{{trigger.input}}'
  const triggerInput = ctx.trigger.input
  if (
    DEFAULT_AGENT_INPUTS.has(template) &&
    triggerInput &&
    typeof triggerInput === 'object' &&
    !Array.isArray(triggerInput)
  ) {
    const payload = triggerInput as Record<string, unknown>
    const slackKind = payload.kind
    const text = payload.text
    if (
      typeof text === 'string' &&
      text.trim() &&
      typeof slackKind === 'string' &&
      ['app_mention', 'message.im', 'message.channels', 'slash_command'].includes(slackKind)
    ) {
      // app_mention text begins with the bot mention; it is transport syntax,
      // not part of the user's question.
      return text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim()
    }
  }
  return resolveTemplate(nodeInput ?? '{{trigger.input}}', ctx)
}

// Node types whose output is meaningful context for a downstream agent. Control
// / structural nodes (condition, loop, trigger, …) carry no payload; variables
// have their own `{{var.*}}` channel. Feeds the `{{upstream}}` aggregate.
const DATA_BEARING_NODE_TYPES: ReadonlySet<FlowNode['type']> = new Set([
  'http', 'tool', 'data', 'transform', 'agent', 'subflow', 'code',
])

/**
 * Deterministically interpret a flow graph. Pure: agent execution is delegated
 * to `opts.runAgent`. Supports nested control flow (loops/parallels containing
 * containers), container-level fail/pause propagation, a stop node, retries,
 * per-step timeout, and full per-node outcome reporting via `opts.onStep`.
 */
export async function interpretFlow(graph: FlowGraph, input: unknown, opts: Opts): Promise<InterpretResult> {
  const maxSteps = opts.maxSteps ?? 100
  const maxLoop = opts.maxLoopIterations ?? 500
  // Resume target key (see the Opts doc): callers that predate resumeKey pass
  // only resumeNodeId — for them the bare id IS the key of any non-loop node,
  // while a loop-body node's path-carrying key safely never matches it.
  const resumeKey = opts.resumeKey ?? opts.resumeNodeId
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  // Constant for the whole run: lets templates reference a step by the label
  // the builder shows on token chips (see readPath's node-label resolution).
  const stepLabels = opts.stepLabels ?? stepLabelsOf(graph)
  // Nodes the author excluded from the {{upstream}} aggregate (noisy payloads).
  const excludeFromContextIds = new Set(
    graph.nodes.filter((node) => (node.data as { excludeFromContext?: boolean }).excludeFromContext === true).map((node) => node.id),
  )
  // ── DAG adjacency ───────────────────────────────────────────────────────────
  // Edges are already many→many in the schema, so a node's parents are simply
  // every edge that targets it.
  const parentsOf = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = parentsOf.get(edge.target)
    if (list) list.push(edge.source)
    else parentsOf.set(edge.target, [edge.source])
  }
  // Container bodies are owned by their container (`body`/`branches`/`fallback`)
  // and carry NO incoming edges, so a body node's lineage is: its container, the
  // container's own ancestors, and the siblings that precede it *within the same
  // body list* (a `parallel` branch never sees a sibling branch).
  const bodyOwner = new Map<string, { containerId: string; priorSiblings: string[] }>()
  for (const node of graph.nodes) {
    const bodies: string[][] =
      node.type === 'loop' || node.type === 'repeatUntil' ? [node.data.body]
      : node.type === 'parallel' ? node.data.branches
      : node.type === 'errorShield' ? [node.data.body, node.data.fallback]
      : []
    for (const body of bodies) {
      body.forEach((id, index) => bodyOwner.set(id, { containerId: node.id, priorSiblings: body.slice(0, index) }))
    }
  }
  // Transitive ancestors of a node — the nodes actually wired into it. This is
  // what makes selective routing real: an agent sees only the sources on its own
  // paths. In a linear chain a node's ancestors ARE every prior node, so this is
  // behavior-identical for existing flows. Memoized per run; `seen` also makes it
  // cycle-safe.
  const ancestorCache = new Map<string, Set<string>>()
  const ancestorsOf = (nodeId: string): Set<string> => {
    const cached = ancestorCache.get(nodeId)
    if (cached) return cached
    const seen = new Set<string>()
    const visit = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      lineage(id)
    }
    // Walk a node's lineage WITHOUT adding the node itself (so `seen` is strictly
    // ancestors, never self).
    function lineage(id: string) {
      for (const parent of parentsOf.get(id) ?? []) visit(parent)
      const owner = bodyOwner.get(id)
      if (!owner) return
      visit(owner.containerId)
      for (const sibling of owner.priorSiblings) visit(sibling)
    }
    lineage(nodeId)
    ancestorCache.set(nodeId, seen)
    return seen
  }

  // Aggregate the data-bearing steps among THIS node's ancestors, keyed by its
  // builder label (id-suffixed on collision so no output is silently dropped).
  const buildUpstream = (ctx: FlowContext, forNodeId: string): Record<string, unknown> => {
    const ancestors = ancestorsOf(forNodeId)
    const bundle: Record<string, unknown> = {}
    for (const [id, entry] of Object.entries(ctx.step)) {
      if (!ancestors.has(id)) continue
      const stepNode = byId.get(id)
      if (!stepNode || !DATA_BEARING_NODE_TYPES.has(stepNode.type) || excludeFromContextIds.has(id)) continue
      const label = stepLabels[id] || id
      let key = label
      for (let n = 2; Object.prototype.hasOwnProperty.call(bundle, key); n += 1) key = `${label} (${n})`
      bundle[key] = entry.output
    }
    return bundle
  }
  // Declared variable types: each name's initialize node (anywhere in the
  // graph, container bodies included) governs how later set/increment values
  // are coerced.
  const declaredTypes = new Map<string, VariableType>()
  for (const node of graph.nodes) {
    if (node.type !== 'variable' || node.data.op !== 'initialize') continue
    const name = node.data.name.trim()
    if (name && !declaredTypes.has(name)) declaredTypes.set(name, node.data.varType ?? 'string')
  }
  const outgoing = (id: string, branch?: string): FlowEdge | undefined =>
    graph.edges.find((edge) => edge.source === id && (branch === undefined || edge.branch === branch || edge.branch === undefined))

  const steps: StepOutcome[] = []
  const emit = (outcome: StepOutcome) => {
    steps.push(outcome)
    opts.onStep?.(outcome)
  }
  // The last output node's bound return object (if any). When set, it becomes
  // the flow's returned output in place of the implicit lastOutput.
  let explicitOutput: { value: unknown } | undefined
  let webhookResponse: InterpretResult['webhookResponse']
  let visits = 0
  const overBudget = () => ++visits > maxSteps

  // Run an agent with optional per-attempt timeout and retry-with-backoff.
  const runAgentWithReliability = async (
    node: Extract<FlowNode, { type: 'agent' }>,
    resolvedInput: string,
    extra: { prompt?: string; thread?: FlowContext['thread']; iterationPath?: number[]; withinThreadedLoop?: boolean },
  ): Promise<RunAgentResult> => {
    const retries = node.data.retries ?? 0
    const timeoutMs = node.data.timeoutMs
    // Key-matched, not bare-id: only the exact iteration that paused resumes
    // (see the `resumeKey` doc on Opts above).
    const resume = resumeKey !== undefined && resumeKey === completedKey(node.id, extra.iterationPath)
    let attempt = 0
    for (;;) {
      const call = opts.runAgent({ id: node.id, agentId: node.data.agentId, input: resolvedInput, prompt: extra.prompt, model: node.data.model, resume, thread: extra.thread, iterationPath: extra.iterationPath, withinThreadedLoop: extra.withinThreadedLoop })
      const raced = timeoutMs ? await raceTimeout(call, timeoutMs) : await call
      // A timeout only ABANDONS the live agent execution — Promise.race cannot
      // cancel it, so it may still be running (and spending tokens / performing
      // side effects). Retrying would start a SECOND concurrent execution, so
      // the shared policy (shouldRetryAfterTimeout) keeps agent timeouts
      // terminal; `retries` still applies to hard errors below.
      if (raced === TIMED_OUT) {
        const error = `Timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s — the agent may still be finishing in the background.`
        if (!shouldRetryAfterTimeout('agent') || attempt >= retries) return { error }
        attempt += 1
        await sleep(Math.min(8000, 250 * 2 ** attempt))
        continue
      }
      const res = raced
      // Retry only hard errors (never a waiting/paused result).
      if (!res.error || res.waiting || attempt >= retries) return res
      attempt += 1
      await sleep(Math.min(8000, 250 * 2 ** attempt))
    }
  }

  // Execute one node against `ctx`. Never routes edges (the main-chain walker
  // and container bodies drive traversal); returns an output or control signal.
  const execNode = async (node: FlowNode, ctx: FlowContext): Promise<NodeResult> => {
    if (overBudget()) return { kind: 'fail', error: 'Flow exceeded the maximum number of steps.' }

    // Refresh the upstream aggregate before this node resolves its fields, so
    // `{{upstream}}` and the agent auto-append see the data-bearing steps on
    // THIS node's own paths (its wired ancestors).
    ctx.upstream = buildUpstream(ctx, node.id)

    if (node.type === 'trigger') return { kind: 'skip' }

    if ((node.type === 'agent' || node.type === 'tool' || node.type === 'http' || node.type === 'code') && node.data.disabled) {
      emit({ nodeId: node.id, status: 'skipped', output: node.data.mockOutput, iterationPath: ctx.iterationPath })
      if (node.data.mockOutput !== undefined) ctx.step[node.id] = { output: node.data.mockOutput }
      return { kind: 'ok', output: node.data.mockOutput }
    }
    if ((node.type === 'agent' || node.type === 'tool' || node.type === 'http' || node.type === 'code') && node.data.mockOutput !== undefined) {
      const output = resolveTemplateValue(node.data.mockOutput, ctx)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output }
    }

    // Resume: a node finished on the prior run is reused, not re-executed.
    // Variable state was already reconstructed by the pre-walk replay (which
    // covers container bodies the walk never enters), so a replayed variable
    // step must NOT re-apply here — that would rewind the symbol table to a
    // value from before a later completed write.
    const key = completedKey(node.id, ctx.iterationPath)
    if (opts.completed && Object.prototype.hasOwnProperty.call(opts.completed, key)) {
      const output = opts.completed[key]
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'skipped', output, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output }
    }

    if (node.type === 'stop') {
      emit({ nodeId: node.id, status: 'stopped', output: node.data.reason ?? 'Flow stopped.', iterationPath: ctx.iterationPath })
      return { kind: 'stop' }
    }

    if (node.type === 'condition' || node.type === 'switch' || node.type === 'router') {
      // Bodies are flat ordered lists (no edges), so branching can't route
      // here. The main-chain walker intercepts condition/switch/router before
      // execNode is consulted, so reaching this arm means the node sits inside
      // a container body — publish validation also rejects that
      // (CONDITION_IN_CONTAINER / ROUTER_IN_CONTAINER); this guards stored
      // pre-validation graphs, which previously mis-ran silently.
      const label = node.type === 'condition' ? 'If / else' : node.type === 'switch' ? 'Switch' : 'AI router'
      const error = `${label} can't run inside a For each / Parallel body — branching isn't supported there.`
      emit({ nodeId: node.id, status: 'failed', error, iterationPath: ctx.iterationPath })
      return { kind: 'fail', error }
    }

    if (node.type === 'humanReview') {
      // Request information: a first-class pause with no agent involved.
      // Resuming this exact node? The reviewer's reply IS the step output.
      // Key-matched (not bare-id): in a loop body, multiple simultaneous
      // humanReview pauses share the same node id — only the iteration whose
      // key matches consumes this reply; the others fall through and re-pause.
      if (resumeKey !== undefined && resumeKey === completedKey(node.id, ctx.iterationPath)) {
        const output = opts.resumeReply ?? ''
        ctx.step[node.id] = { output }
        emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
        return { kind: 'ok', output }
      }
      // First visit: resolve the message and pause the run. The outcome carries
      // the same `{ waiting: { kind: 'input', question } }` shape the agent
      // adapter persists, so execute-flow's onStep path can store it verbatim
      // and the existing reply machinery renders/answers it unchanged.
      const question = resolveTemplate(node.data.message, ctx)
      emit({ nodeId: node.id, status: 'waiting', output: { waiting: { kind: 'input', question } }, iterationPath: ctx.iterationPath })
      return { kind: 'pause', nodeId: node.id, question }
    }

    if (node.type === 'respondWebhook') {
      let headers: Record<string, string> = {}
      if (node.data.headers?.trim()) {
        try {
          const parsed = resolveTemplateValue(JSON.parse(node.data.headers), ctx)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Headers must be a JSON object.')
          headers = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Headers must be valid JSON.'
          emit({ nodeId: node.id, status: 'failed', error: message, iterationPath: ctx.iterationPath })
          return { kind: 'fail', error: message }
        }
      }
      let body = node.data.bodyMode === 'none' ? undefined : resolveTemplateValue(node.data.body ?? '', ctx)
      if (node.data.bodyMode === 'json' && typeof body === 'string' && body.trim()) {
        try { body = JSON.parse(body) } catch {
          const error = 'Webhook response body is not valid JSON after template substitution.'
          emit({ nodeId: node.id, status: 'failed', error, iterationPath: ctx.iterationPath })
          return { kind: 'fail', error }
        }
      }
      webhookResponse = { statusCode: node.data.statusCode, headers, bodyMode: node.data.bodyMode, body }
      ctx.step[node.id] = { output: webhookResponse }
      emit({ nodeId: node.id, status: 'succeeded', output: webhookResponse, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output: webhookResponse }
    }

    if (node.type === 'wait') {
      const resume = resumeKey !== undefined && resumeKey === completedKey(node.id, ctx.iterationPath)
      if (resume) {
        const output = { waited: true }
        ctx.step[node.id] = { output }
        emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
        return { kind: 'ok', output }
      }
      const multiplier = node.data.unit === 'days' ? 86_400_000 : node.data.unit === 'hours' ? 3_600_000 : node.data.unit === 'minutes' ? 60_000 : 1000
      const wakeAt = new Date(Date.now() + node.data.amount * multiplier).toISOString()
      emit({ nodeId: node.id, status: 'waiting', output: { waiting: { kind: 'time', wakeAt } }, iterationPath: ctx.iterationPath })
      return { kind: 'pause', nodeId: node.id, wakeAt }
    }

    if (node.type === 'code') {
      if (!opts.runCode) {
        const error = 'Code steps are not available in this execution context.'
        emit({ nodeId: node.id, status: 'failed', error, iterationPath: ctx.iterationPath })
        return { kind: 'fail', error }
      }
      // The item list: an explicit `input` template wins; inside a loop body
      // the current item is the natural subject; otherwise the direct
      // parents' outputs (one parent = its output, several = an array), and a
      // source-less code step falls back to the trigger input. An array IS
      // the item list; a single value is one item — n8n's items semantics.
      let itemsSource: unknown
      if (typeof node.data.input === 'string' && node.data.input.trim()) {
        itemsSource = resolveTemplateValue(node.data.input, ctx)
      } else if (ctx.item !== undefined) {
        itemsSource = ctx.item
      } else {
        const owned = bodyOwner.get(node.id)
        const direct = parentsOf.get(node.id) ?? []
        const parentIds = direct.length ? direct : owned?.priorSiblings.length ? [owned.priorSiblings.at(-1)!] : []
        const outputs = parentIds.map((id) => ctx.step[id]?.output).filter((value) => value !== undefined)
        itemsSource = outputs.length === 0 ? ctx.trigger.input : outputs.length === 1 ? outputs[0] : outputs
      }
      const items = Array.isArray(itemsSource) ? itemsSource : itemsSource == null ? [] : [itemsSource]

      // Captured print()/console.log() lines travel on the outcome in BOTH
      // directions — a failure's logs are precisely the ones worth reading.
      const logs: string[] = []
      const fail = (error: string) => {
        emit({ nodeId: node.id, status: 'failed', error, ...(logs.length ? { logs } : {}), iterationPath: ctx.iterationPath })
        if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok' as const, output: undefined }
        return { kind: 'fail' as const, error }
      }
      const base = { id: node.id, language: node.data.language, code: node.data.code, timeoutMs: node.data.timeoutMs }
      let output: unknown
      if (node.data.mode === 'eachItem') {
        const collected: unknown[] = []
        for (const item of items) {
          const result = await opts.runCode({ ...base, items, item })
          logs.push(...result.logs)
          if (!result.ok) return fail(result.error)
          collected.push(result.output)
        }
        output = collected
      } else {
        const result = await opts.runCode({ ...base, items })
        logs.push(...result.logs)
        if (!result.ok) return fail(result.error)
        output = result.output
      }
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output, ...(logs.length ? { logs } : {}), iterationPath: ctx.iterationPath })
      return { kind: 'ok', output }
    }

    if (node.type === 'transform') {
      // Build an object from templated field assignments (deterministic "Set").
      // A value that parses as JSON (number/bool/object/array) is typed; anything
      // else stays a string.
      const output: Record<string, unknown> = {}
      for (const field of node.data.fields) {
        if (!field.name) continue
        const resolved = resolveTemplate(field.value, ctx)
        let value: unknown = resolved
        try {
          value = JSON.parse(resolved)
        } catch {
          /* not JSON — keep the string */
        }
        output[field.name] = value
      }
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output }
    }

    if (node.type === 'variable') {
      const res = applyVariableOp(node, ctx, declaredTypes)
      if ('error' in res) {
        emit({ nodeId: node.id, status: 'failed', error: res.error, iterationPath: ctx.iterationPath })
        return { kind: 'fail', error: res.error }
      }
      ctx.step[node.id] = { output: res.output }
      emit({ nodeId: node.id, status: 'succeeded', output: res.output, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output: res.output }
    }

    if (node.type === 'data') {
      // Pure transform: resolve the input template here (an exact token keeps
      // its structure), then delegate to the side-effect-free op runner.
      // filterArray clauses / select values resolve per item inside runDataOp,
      // with this ctx riding along so step/trigger/var tokens keep working.
      const input = node.data.input?.trim() ? resolveTemplateValue(node.data.input, ctx) : undefined
      const res = runDataOp(node.data.op, {
        input,
        separator: node.data.separator === undefined ? undefined : resolveTemplate(node.data.separator, ctx),
        schema: node.data.schema,
        clauses: node.data.clauses,
        fields: node.data.fields,
        ctx,
      })
      if ('error' in res) {
        emit({ nodeId: node.id, status: 'failed', error: res.error, iterationPath: ctx.iterationPath })
        return { kind: 'fail', error: res.error }
      }
      ctx.step[node.id] = { output: res.output }
      emit({ nodeId: node.id, status: 'succeeded', output: res.output, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output: res.output }
    }

    if (node.type === 'filter') {
      // Gate: pass through when the condition holds; else drop (loop) / end (chain).
      const passed = evalCondition(node.data, ctx)
      if (passed) {
        emit({ nodeId: node.id, status: 'succeeded', output: true, iterationPath: ctx.iterationPath })
        return { kind: 'ok', output: undefined }
      }
      emit({ nodeId: node.id, status: 'skipped', output: false, iterationPath: ctx.iterationPath })
      return { kind: 'drop' }
    }

    if (node.type === 'tool' || node.type === 'http') {
      // Resolve every template in the node config, then delegate to runAction.
      let resolvedArgs: unknown = resolveTemplate(node.type === 'tool' ? node.data.args ?? '{}' : '{}', ctx)
      if (node.type === 'tool') {
        try {
          resolvedArgs = resolveTemplateValue(JSON.parse(node.data.args ?? '{}'), ctx)
        } catch {
          resolvedArgs = resolveTemplate(node.data.args ?? '{}', ctx)
        }
      }
      const config: Record<string, unknown> =
        node.type === 'tool'
          ? {
              connectionId: node.data.connectionId,
              toolName: node.data.toolName,
              args: resolvedArgs,
              retries: node.data.retries,
              timeoutMs: node.data.timeoutMs,
              ...(node.data.risk ? { risk: node.data.risk } : {}),
            }
          : {
              ...(node.data.connectionId ? { connectionId: node.data.connectionId } : {}),
              // Vault credential reference — an opaque id, resolved server-side
              // at fetch time. Never a secret, so nothing to resolve here.
              ...(node.data.credentialId ? { credentialId: node.data.credentialId } : {}),
              ...(node.data.authMode ? { authMode: node.data.authMode } : {}),
              ...(node.data.auth ? { auth: resolveTemplateValue(node.data.auth, ctx) } : {}),
              method: node.data.method,
              url: resolveTemplate(node.data.url, ctx),
              query: resolveConfigValue(node.data.query, ctx),
              ...(node.data.sendQuery !== undefined ? { sendQuery: node.data.sendQuery } : {}),
              ...(node.data.queryArrayFormat ? { queryArrayFormat: node.data.queryArrayFormat } : {}),
              headers: resolveConfigValue(node.data.headers, ctx),
              ...(node.data.sendHeaders !== undefined ? { sendHeaders: node.data.sendHeaders } : {}),
              body: resolveConfigValue(node.data.body, ctx),
              ...(node.data.sendBody !== undefined ? { sendBody: node.data.sendBody } : {}),
              ...(node.data.bodyContentType !== undefined ? { bodyContentType: resolveTemplate(node.data.bodyContentType, ctx) } : {}),
              ...(node.data.graphqlVariables !== undefined ? { graphqlVariables: resolveConfigValue(node.data.graphqlVariables, ctx) } : {}),
              ...(node.data.cookie !== undefined ? { cookie: resolveTemplate(node.data.cookie, ctx) } : {}),
              bodyMode: node.data.bodyMode,
              responseType: node.data.responseType,
              failOnHttpError: node.data.failOnHttpError,
              retries: node.data.retries,
              timeoutMs: node.data.timeoutMs,
              ...(node.data.retryDelayMs !== undefined ? { retryDelayMs: node.data.retryDelayMs } : {}),
              ...(node.data.retryStatusCodes ? { retryStatusCodes: node.data.retryStatusCodes } : {}),
              ...(node.data.followRedirects !== undefined ? { followRedirects: node.data.followRedirects } : {}),
              ...(node.data.maxRedirects !== undefined ? { maxRedirects: node.data.maxRedirects } : {}),
              ...(node.data.pagination ? { pagination: resolveTemplateValue(node.data.pagination, ctx) } : {}),
              ...(node.data.batch ? { batch: node.data.batch } : {}),
            }
      const res: RunAgentResult = opts.runAction
        ? await opts.runAction({
            id: node.id,
            kind: node.type,
            config,
            resume: resumeKey !== undefined && resumeKey === completedKey(node.id, ctx.iterationPath),
            iterationPath: ctx.iterationPath,
          })
        : { error: `${node.type} steps are not supported in this runtime.` }
      if (res.waiting) {
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: node.id, question: res.waiting.question }
      }
      if (res.error) {
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        if ((node.data.onError ?? 'stop') === 'continue') {
          // Record a structured failure so downstream refs + the {{upstream}}
          // aggregate see "this call failed" instead of a silent blank.
          const failure = { ok: false, error: res.error }
          ctx.step[node.id] = { output: failure }
          return { kind: 'ok', output: failure }
        }
        return { kind: 'fail', error: res.error }
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'output') {
      const bound = bindOutputFields(node.data.fields, (template) => resolveTemplateValue(template, ctx))
      if ('error' in bound) {
        emit({ nodeId: node.id, status: 'failed', error: bound.error })
        return { kind: 'fail', error: bound.error }
      }
      explicitOutput = { value: bound.output }
      ctx.step[node.id] = { output: bound.output }
      emit({ nodeId: node.id, status: 'succeeded', output: bound.output })
      return { kind: 'ok', output: bound.output }
    }

    if (node.type === 'input') {
      const resolved = resolveInputParams(node.data.params, {
        user: (ctx.trigger.input && typeof ctx.trigger.input === 'object' && !Array.isArray(ctx.trigger.input))
          ? (ctx.trigger.input as Record<string, unknown>)
          : undefined,
        webhook: (opts.webhookInput && typeof opts.webhookInput === 'object' && !Array.isArray(opts.webhookInput))
          ? (opts.webhookInput as Record<string, unknown>)
          : undefined,
      })
      if ('error' in resolved) {
        emit({ nodeId: node.id, status: 'failed', error: resolved.error })
        return { kind: 'fail', error: resolved.error }
      }
      ctx.input = { ...(ctx.input ?? {}), ...resolved.values }
      ctx.step[node.id] = { output: resolved.values }
      emit({ nodeId: node.id, status: 'succeeded', output: resolved.values })
      return { kind: 'ok', output: resolved.values }
    }

    if (node.type === 'agent') {
      const outputFields = node.data.outputFields ?? []
      const structured = node.data.responseFormat === 'structured' && outputFields.some((field) => field.name.trim())
      let resolved = agentInput(node.data.input, ctx)
      // Auto-aggregation: feed the agent every prior data-bearing node's captured
      // output so it works from the whole flow's context. This fires for a node
      // using its DEFAULT input (the common "saved agent after some API steps"
      // shape — the agent's instructions live in its persona, the node input is
      // just {{trigger.input}}). A hand-customized input is left exactly as
      // authored unless it opts in (includeUpstream === true) or references
      // {{upstream}} itself. Opt out entirely with includeUpstream === false.
      if (node.data.includeUpstream !== false) {
        const authoredInput = node.data.input?.trim() ?? ''
        const usesDefaultInput = authoredInput === '' || DEFAULT_AGENT_INPUTS.has(authoredInput)
        const referencesUpstream = /\{\{\s*upstream\b/.test(`${node.data.input ?? ''} ${node.data.prompt ?? ''}`)
        const bundle = ctx.upstream ?? {}
        if ((node.data.includeUpstream === true || usesDefaultInput) && !referencesUpstream && Object.keys(bundle).length > 0) {
          resolved = `${resolved}\n\nUpstream data:\n${serializeUpstream(bundle)}`
        }
      }
      if (structured) resolved = `${resolved}\n\n${structuredResponseInstruction(outputFields)}`
      const inline = !node.data.agentId?.trim()
      const prompt = inline ? resolveTemplate(node.data.prompt ?? '', ctx) : undefined
      const res = await runAgentWithReliability(node, resolved, { prompt, thread: ctx.thread, iterationPath: ctx.iterationPath, withinThreadedLoop: ctx.withinThreadedLoop === true })
      if (res.waiting) {
        if (node.data.humanAssistance === false) {
          const error = 'The agent asked for help, but human assistance is turned off for this step.'
          emit({ nodeId: node.id, status: 'failed', error })
          if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok', output: undefined }
          return { kind: 'fail', error }
        }
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: node.id, question: res.waiting.question }
      }
      if (res.error) {
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok', output: undefined }
        return { kind: 'fail', error: res.error }
      }
      let output: unknown
      if (structured) {
        const parsed = parseStructuredAgentOutput(res.output, outputFields)
        if (parsed.error) {
          emit({ nodeId: node.id, status: 'failed', error: parsed.error })
          if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok', output: undefined }
          return { kind: 'fail', error: parsed.error }
        }
        output = parsed.output
      } else {
        output = asStructured(res.output)
      }
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'subflow') {
      // Map parent context -> child input (JSON object of templated values, same
      // shape as a tool node's args). No mapping -> pass the current loop item (or {}).
      let childInput: unknown = ctx.item ?? {}
      if (node.data.input?.trim()) {
        try {
          childInput = resolveTemplateValue(JSON.parse(node.data.input), ctx)
        } catch {
          childInput = resolveTemplateValue(node.data.input, ctx)
        }
      }
      const res: RunFlowResult = opts.runFlow
        ? await opts.runFlow({
            id: node.id,
            flowId: node.data.flowId,
            input: childInput,
            resume: resumeKey !== undefined && resumeKey === completedKey(node.id, ctx.iterationPath),
            iterationPath: ctx.iterationPath,
          })
        : { error: 'Subflow steps are not supported in this runtime.' }
      if (res.waiting) {
        // The child paused — park the parent on this node. The adapter already
        // persisted the waiting step row (with the child run id); a resume
        // re-enters this exact node and forwards the reply into the child.
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: node.id, question: res.waiting.question, wakeAt: res.waiting.wakeAt }
      }
      if (res.error) {
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok', output: undefined }
        return { kind: 'fail', error: res.error }
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'loop') {
      const items = loopItems(resolveTemplate(node.data.over, ctx)).slice(0, maxLoop)
      const threaded = node.data.threadAgent === true
      // Threading ONE conversation across iterations requires sequential
      // execution — you cannot append turns to one conversation concurrently.
      const concurrency = threaded ? 1 : (node.data.concurrency ?? 1)
      const runItem = (item: unknown, index: number) => {
        // `variables` is shared by reference: writes inside the body persist
        // past the loop (one flow-global symbol table, MS parity).
        const itemCtx: FlowContext = {
          trigger: ctx.trigger, step: { ...ctx.step }, item, loop: { index, count: items.length },
          variables: ctx.variables, input: ctx.input, stepLabels: ctx.stepLabels,
          iterationPath: [...(ctx.iterationPath ?? []), index],
          withinThreadedLoop: threaded || ctx.withinThreadedLoop === true,
          ...(threaded ? { thread: { key: node.id, iteration: index } } : {}),
        }
        return execBody(node.data.body, itemCtx)
      }
      let perItem: Awaited<ReturnType<typeof execBody>>[]
      if (threaded) {
        // A threaded loop chains one conversation across iterations; each
        // iteration is seeded from the previous iteration's agent execution.
        // A pause/fail/stop must halt the chain — running ahead would seed the
        // next turn from an unfinished transcript (an invalid
        // assistant(tool_use)->user request) and fire premature, later-
        // duplicated side-effects. A 'drop' (filter) is not terminal: continue.
        perItem = []
        for (let index = 0; index < items.length; index++) {
          const r = await runItem(items[index], index)
          perItem.push(r)
          if (r.control !== undefined && r.control.kind !== 'drop') break
        }
      } else {
        perItem = await mapLimit(items, concurrency, runItem)
      }
      // Propagate the first hard control (stop / fail / pause); a 'drop' (filter)
      // just removes that item from the collected output.
      const control = perItem.map((r) => r.control).find((c): c is NodeResult => c !== undefined && c.kind !== 'drop')
      if (control) {
        emit({ nodeId: node.id, status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped', iterationPath: ctx.iterationPath })
        return control
      }
      const output = perItem.filter((r) => r.control?.kind !== 'drop').map((r) => r.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output }
    }

    if (node.type === 'repeatUntil') {
      let output: unknown = ctx.item
      for (let iteration = 0; iteration < node.data.maxIterations; iteration += 1) {
        const iterationCtx: FlowContext = { ...ctx, step: { ...ctx.step }, loop: { index: iteration, count: node.data.maxIterations }, iterationPath: [...(ctx.iterationPath ?? []), iteration] }
        const result = await execBody(node.data.body, iterationCtx)
        if (result.control && result.control.kind !== 'drop') {
          emit({ nodeId: node.id, status: result.control.kind === 'fail' ? 'failed' : result.control.kind === 'pause' ? 'waiting' : 'stopped', iterationPath: ctx.iterationPath })
          return result.control
        }
        output = result.output
        ctx.step = { ...ctx.step, ...iterationCtx.step }
        if (evalCondition(node.data, iterationCtx)) {
          ctx.step[node.id] = { output }
          emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
          return { kind: 'ok', output }
        }
        if (node.data.delayMs) await sleep(node.data.delayMs)
      }
      const error = `Repeat until reached its ${node.data.maxIterations}-run safety limit.`
      emit({ nodeId: node.id, status: 'failed', error, iterationPath: ctx.iterationPath })
      return { kind: 'fail', error }
    }

    if (node.type === 'parallel') {
      const results = await Promise.all(
        node.data.branches.map(async (branch) => {
          const branchCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item: ctx.item, loop: ctx.loop, variables: ctx.variables, input: ctx.input, stepLabels: ctx.stepLabels, iterationPath: ctx.iterationPath, withinThreadedLoop: ctx.withinThreadedLoop === true }
          const res = await execBody(branch, branchCtx)
          return { key: branch[0] ?? node.id, res }
        }),
      )
      const control = results.map((r) => r.res.control).find((c): c is NodeResult => c !== undefined && c.kind !== 'drop')
      if (control) {
        emit({ nodeId: node.id, status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped', iterationPath: ctx.iterationPath })
        return control
      }
      const entries = results
        .map((r, index) => ({ key: r.key, output: r.res.output, label: node.data.labels?.[index], dropped: r.res.control?.kind === 'drop' }))
        .filter((e) => !e.dropped)
      const output = joinBranchOutputs(entries, node.data.join)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output }
    }

    if (node.type === 'errorShield') {
      const bodyCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item: ctx.item, loop: ctx.loop, variables: ctx.variables, input: ctx.input, stepLabels: ctx.stepLabels, thread: ctx.thread, iterationPath: ctx.iterationPath, withinThreadedLoop: ctx.withinThreadedLoop === true }
      const bodyRes = await execBody(node.data.body, bodyCtx)
      const control = bodyRes.control
      // Only a hard failure is shielded → fallback. pause/stop/drop propagate.
      if (control && control.kind === 'fail') {
        const fbCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item: ctx.item, loop: ctx.loop, variables: ctx.variables, input: ctx.input, stepLabels: ctx.stepLabels, thread: ctx.thread, error: control.error, iterationPath: ctx.iterationPath, withinThreadedLoop: ctx.withinThreadedLoop === true }
        const fbRes = await execBody(node.data.fallback, fbCtx)
        if (fbRes.control && fbRes.control.kind !== 'drop') {
          // The fallback itself failed/paused/stopped — surface that, unshielded.
          emit({ nodeId: node.id, status: fbRes.control.kind === 'fail' ? 'failed' : fbRes.control.kind === 'pause' ? 'waiting' : 'stopped', iterationPath: ctx.iterationPath })
          return fbRes.control
        }
        const output = fbRes.output
        ctx.step[node.id] = { output }
        emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
        return { kind: 'ok', output }
      }
      if (control && control.kind !== 'drop') {
        emit({ nodeId: node.id, status: control.kind === 'pause' ? 'waiting' : 'stopped', iterationPath: ctx.iterationPath })
        return control
      }
      const output = bodyRes.output
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output, iterationPath: ctx.iterationPath })
      return { kind: 'ok', output }
    }

    return { kind: 'skip' }
  }

  // Execute an ordered list of node ids (a loop body / parallel branch) as a
  // sequence, threading outputs. Stops on the first control signal.
  const execBody = async (nodeIds: string[], ctx: FlowContext): Promise<{ output: unknown; control?: NodeResult }> => {
    let last: unknown = ctx.item
    for (const id of nodeIds) {
      const node = byId.get(id)
      if (!node) continue
      if (node.type === 'condition' || node.type === 'switch' || node.type === 'router') {
        let branch = 'default'
        if (node.type === 'condition') branch = evalCondition(node.data, ctx) ? 'true' : 'false'
        else if (node.type === 'switch') branch = node.data.cases.find((candidate) => evalClause({ left: candidate.left, op: candidate.op, right: candidate.right }, ctx))?.id ?? 'default'
        else {
          const prior = opts.completed?.[completedKey(node.id, ctx.iterationPath)]
          if (typeof prior === 'string' && prior) branch = prior
          else if (!opts.routeAi) return { output: last, control: { kind: 'fail', error: 'Router steps need an AI runtime.' } }
          else {
            const routed = await opts.routeAi({ id: node.id, branches: node.data.branches, instructions: node.data.instructions, input: resolveTemplate(node.data.input ?? '{{trigger.input}}', ctx) })
            if ('error' in routed) return { output: last, control: { kind: 'fail', error: routed.error } }
            branch = routed.branch
          }
        }
        ctx.step[node.id] = { output: branch }
        emit({ nodeId: node.id, status: 'succeeded', output: branch, iterationPath: ctx.iterationPath })
        const head = outgoing(node.id, branch) ?? outgoing(node.id, 'default')
        if (head) {
          const chain: string[] = []
          const seen = new Set<string>()
          let cursor: string | undefined = head.target
          while (cursor && !seen.has(cursor)) {
            seen.add(cursor)
            chain.push(cursor)
            const next = outgoing(cursor)
            cursor = next?.target
          }
          const routed = await execBody(chain, ctx)
          if (routed.control) return routed
          last = routed.output
        }
        continue
      }
      const res = await execNode(node, ctx)
      if (res.kind === 'ok') {
        if (res.output !== undefined) {
          ctx.step[id] = { output: res.output }
          last = res.output
        }
        continue
      }
      if (res.kind === 'skip') continue
      return { output: last, control: res }
    }
    return { output: last }
  }

  // Node ids that live inside a container must not be reached by the main walk.
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body
      : node.type === 'repeatUntil' ? node.data.body
      : node.type === 'parallel' ? node.data.branches.flat()
      : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
      : [],
    ),
  )

  const ctx: FlowContext = { trigger: { input }, step: {}, variables: {}, stepLabels }

  // Resume: rebuild the symbol table from EVERY completed variable step before
  // walking. A completed loop/parallel short-circuits without entering its
  // body, so writes made inside container bodies would otherwise be lost.
  // `completed` preserves execution order (execute-flow builds it from step
  // rows ordered `order asc`), and each stored output IS the variable's
  // post-op value, so replay assigns outputs in that order — it never re-runs
  // the op — leaving the correct last write per name in place.
  if (opts.completed) {
    const variables = (ctx.variables ??= {})
    for (const [key, output] of Object.entries(opts.completed)) {
      const nodeId = nodeIdOfCompletedKey(key)
      const node = byId.get(nodeId)
      ctx.step[nodeId] = { output }
      if (node?.type === 'variable' && node.data.name.trim()) variables[node.data.name.trim()] = output
      if (node?.type === 'input' && output && typeof output === 'object' && !Array.isArray(output)) {
        ctx.input = { ...(ctx.input ?? {}), ...(output as Record<string, unknown>) }
      }
      // Restore the explicit flow output too: an output node that ran before a
      // downstream pause is in `completed` and is skipped on resume, so without
      // this terminalOutput() would fall back to lastOutput and return the wrong
      // value (the reply string instead of the bound output object).
      if (node?.type === 'output' && output && typeof output === 'object' && !Array.isArray(output)) {
        explicitOutput = { value: output }
      }
    }
  }

  // Trigger-level filter ("only run when…"): a run whose trigger payload fails
  // the filter completes immediately as skipped — no steps execute. Evaluated
  // here (not in the dispatchers) so webhook/schedule/signal/manual all share
  // one path and the skipped run stays visible in run history.
  const triggerNode = graph.nodes.find((node) => node.type === 'trigger')
  const triggerFilter =
    triggerNode?.type === 'trigger'
      ? ((triggerNode.data.trigger as { filter?: Parameters<typeof evalCondition>[0] } | undefined)?.filter ?? undefined)
      : undefined
  if (triggerFilter?.clauses?.length && !evalCondition(triggerFilter, ctx)) {
    const output = 'Trigger filter did not match — run skipped.'
    emit({ nodeId: triggerNode!.id, status: 'skipped', output })
    return { status: 'succeeded', steps, output }
  }

  let lastOutput: unknown = input
  // Prefer the explicit output node's bound object when one ran; otherwise the
  // implicit lastOutput (back-compat for flows with no output node).
  const terminalOutput = () => (explicitOutput ? explicitOutput.value : lastOutput)

  // ── DAG scheduler ───────────────────────────────────────────────────────────
  // Replaces the old single-chain walk. A node becomes runnable once every one
  // of its parents has settled or been pruned; all runnable nodes execute
  // concurrently (bounded). A linear graph — every node with ≤1 parent — yields
  // exactly the old sequential order, so existing flows are unaffected.

  // An edge INTO a container-body node passes through to the first non-contained
  // node (mirrors the old walk's contained-skip); edges FROM a body node are the
  // container's business, never the top-level DAG's.
  const passThrough = (id: string | undefined): string | undefined => {
    const seen = new Set<string>()
    let cursor = id
    while (cursor && contained.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      cursor = outgoing(cursor)?.target
    }
    return cursor
  }
  type DagEdge = { source: string; target: string; branch?: string }
  const outEdges = new Map<string, DagEdge[]>()
  const inEdges = new Map<string, DagEdge[]>()
  const pushEdge = (map: Map<string, DagEdge[]>, key: string, edge: DagEdge) => {
    const list = map.get(key)
    if (list) list.push(edge)
    else map.set(key, [edge])
  }
  for (const edge of graph.edges) {
    if (contained.has(edge.source)) continue
    const target = passThrough(edge.target)
    if (!target || !byId.has(target)) continue
    const dagEdge: DagEdge = { source: edge.source, target, branch: edge.branch }
    pushEdge(outEdges, edge.source, dagEdge)
    pushEdge(inEdges, target, dagEdge)
  }

  // Single-node mode guards. An unknown onlyNodeId must NOT fall through to
  // the trigger — that would silently promote a one-node test into a full
  // run. And a container's behaviour IS running its body, so isolating one is
  // meaningless; its body steps are individually testable instead.
  const ONLY_NODE_CONTAINERS = new Set(['loop', 'parallel', 'repeatUntil', 'errorShield'])
  if (opts.onlyNodeId) {
    const target = byId.get(opts.onlyNodeId)
    if (!target) throw new Error('That step is no longer part of this flow — reopen it and try again.')
    if (ONLY_NODE_CONTAINERS.has(target.type)) {
      throw new Error('This step contains other steps — test the steps inside it individually.')
    }
  }
  const startId =
    (opts.onlyNodeId && byId.get(opts.onlyNodeId)?.id) ||
    (opts.startNodeId && byId.get(opts.startNodeId)?.id) ||
    byId.get('trigger')?.id ||
    graph.nodes[0]?.id
  // Only nodes reachable from the entry participate — an orphan subgraph never
  // ran under the old walk and must not start running now.
  const reachable = new Set<string>()
  if (startId) {
    if (opts.onlyNodeId) {
      // Single-node mode: the walk never leaves this node, so everything
      // downstream is structurally unreachable rather than conditionally
      // skipped. Retry, timeout, token resolution, budget caps, and audit all
      // keep working unchanged.
      reachable.add(startId)
    } else {
      const stack = [startId]
      while (stack.length) {
        const id = stack.pop()!
        if (reachable.has(id)) continue
        reachable.add(id)
        for (const edge of outEdges.get(id) ?? []) stack.push(edge.target)
      }
    }
  }

  const remainingParents = new Map<string, number>()
  for (const id of reachable) {
    remainingParents.set(id, (inEdges.get(id) ?? []).filter((edge) => reachable.has(edge.source)).length)
  }
  const settledNodes = new Set<string>()
  const prunedNodes = new Set<string>()
  const liveParent = new Set<string>()
  const ready: string[] = []
  for (const id of reachable) if ((remainingParents.get(id) ?? 0) === 0) ready.push(id)

  // Which outgoing edges a settled node activates. A branch node lights only the
  // edges carrying its chosen label (falling back to unlabelled edges, mirroring
  // `outgoing`); every other node fans out to all of its edges.
  const activeEdges = (edges: DagEdge[], branch?: string): Set<DagEdge> => {
    if (branch === undefined) return new Set(edges)
    const matching = edges.filter((edge) => edge.branch === branch)
    return new Set(matching.length ? matching : edges.filter((edge) => edge.branch === undefined))
  }

  const prune = (id: string) => {
    if (prunedNodes.has(id) || settledNodes.has(id)) return
    prunedNodes.add(id)
    for (const edge of outEdges.get(id) ?? []) release(edge.target, false)
  }
  // One parent resolved for `targetId`. `live` = that parent settled AND its edge
  // to me was activated. When the last parent resolves: run if any parent was
  // live, else prune (and propagate).
  function release(targetId: string, live: boolean) {
    if (!reachable.has(targetId)) return
    if (live) liveParent.add(targetId)
    const left = (remainingParents.get(targetId) ?? 0) - 1
    remainingParents.set(targetId, left)
    if (left > 0) return
    if (liveParent.has(targetId)) ready.push(targetId)
    else prune(targetId)
  }

  type Disposition =
    | { kind: 'settled'; branch?: string }
    | { kind: 'fail'; error: string }
    | { kind: 'pause'; nodeId: string; question?: string; wakeAt?: string }
    | { kind: 'stop' }

  // Branch nodes are evaluated here (they never went through execNode); everything
  // else delegates. Returns the node's disposition plus, for branch nodes, the
  // chosen label so the scheduler knows which edges to light.
  const runOne = async (node: FlowNode, nctx: FlowContext): Promise<Disposition> => {
    if (node.type === 'condition') {
      if (overBudget()) return { kind: 'fail', error: 'Flow exceeded the maximum number of steps.' }
      return { kind: 'settled', branch: evalCondition(node.data, nctx) ? 'true' : 'false' }
    }
    if (node.type === 'switch') {
      if (overBudget()) return { kind: 'fail', error: 'Flow exceeded the maximum number of steps.' }
      // First matching case wins; otherwise the 'default' edge.
      const hit = node.data.cases.find((c) => evalClause({ left: c.left, op: c.op, right: c.right }, nctx))
      emit({ nodeId: node.id, status: 'succeeded', output: hit?.id ?? 'default' })
      return { kind: 'settled', branch: hit ? hit.id : 'default' }
    }
    if (node.type === 'router') {
      if (overBudget()) return { kind: 'fail', error: 'Flow exceeded the maximum number of steps.' }
      // Resume stability: reuse the branch chosen on the first run (the stored
      // output IS the branch id). Re-calling the model could route differently.
      const prior = opts.completed && Object.prototype.hasOwnProperty.call(opts.completed, node.id) ? opts.completed[node.id] : undefined
      if (typeof prior === 'string' && prior) {
        emit({ nodeId: node.id, status: 'skipped', output: prior })
        return { kind: 'settled', branch: prior }
      }
      if (!opts.routeAi) {
        const error = 'Router steps need an AI runtime and are not supported in this runtime.'
        emit({ nodeId: node.id, status: 'failed', error })
        return { kind: 'fail', error }
      }
      const routerInput = resolveTemplate(node.data.input ?? '{{trigger.input}}', nctx)
      const res = await opts.routeAi({ id: node.id, branches: node.data.branches, instructions: node.data.instructions, input: routerInput })
      if ('error' in res) {
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        return { kind: 'fail', error: res.error }
      }
      ctx.step[node.id] = { output: res.branch }
      emit({ nodeId: node.id, status: 'succeeded', output: res.branch })
      return { kind: 'settled', branch: res.branch }
    }
    const res = await execNode(node, nctx)
    if (res.kind === 'fail') return { kind: 'fail', error: res.error }
    if (res.kind === 'pause') return { kind: 'pause', nodeId: res.nodeId, question: res.question, wakeAt: res.wakeAt }
    // A stop node or a main-chain filter that didn't pass ends the flow cleanly.
    if (res.kind === 'stop' || res.kind === 'drop') return { kind: 'stop' }
    if (res.kind === 'ok' && res.output !== undefined) lastOutput = res.output
    return { kind: 'settled' }
  }

  let halt: InterpretResult | undefined
  const inflight = new Set<Promise<void>>()
  const cap = Math.max(1, opts.maxConcurrency ?? 8)

  const runNode = async (id: string) => {
    const node = byId.get(id)
    if (!node) return
    // Per-node context: `upstream` is assigned per node, so concurrent nodes must
    // not share that field. The spread shares `step`/`variables` BY REFERENCE, so
    // writes stay globally visible; `input` is the one field a node reassigns
    // outright, so it is merged back below.
    const nctx: FlowContext = { ...ctx, upstream: buildUpstream(ctx, id) }
    const disposition = await runOne(node, nctx)
    if (nctx.input !== ctx.input) ctx.input = { ...(ctx.input ?? {}), ...(nctx.input ?? {}) }

    if (disposition.kind === 'fail') {
      halt ??= { status: 'failed', steps, output: lastOutput, error: disposition.error, webhookResponse }
      return
    }
    if (disposition.kind === 'pause') {
      halt ??= {
        status: 'waiting', steps, output: lastOutput,
        waiting: { nodeId: disposition.nodeId, question: disposition.question, ...(disposition.wakeAt ? { wakeAt: disposition.wakeAt } : {}) },
        webhookResponse,
      }
      return
    }
    if (disposition.kind === 'stop') {
      halt ??= { status: 'succeeded', steps, output: terminalOutput(), webhookResponse }
      return
    }
    settledNodes.add(id)
    const edges = outEdges.get(id) ?? []
    const active = activeEdges(edges, disposition.branch)
    for (const edge of edges) release(edge.target, active.has(edge))
  }

  // Drain: launch every runnable node (up to the cap), then wait for the next one
  // to settle and re-evaluate. On halt we stop admitting work but let in-flight
  // nodes finish so nothing is lost mid-write.
  for (;;) {
    // A requested stop halts exactly like fail/pause: no new admissions,
    // in-flight work completes, and the partial output is preserved.
    if (!halt && opts.shouldStop && (await opts.shouldStop())) {
      halt = { status: 'stopped', steps, output: lastOutput, webhookResponse }
    }
    while (!halt && ready.length && inflight.size < cap) {
      const id = ready.shift()!
      const promise = runNode(id).finally(() => { inflight.delete(promise) })
      inflight.add(promise)
    }
    if (!inflight.size) break
    await Promise.race(inflight)
  }
  if (halt) return halt

  // A reachable node that never settled or pruned means its parents never all
  // resolved — i.e. a cycle. Fail loudly rather than silently skipping it.
  const stalled = [...reachable].filter((id) => !settledNodes.has(id) && !prunedNodes.has(id))
  if (stalled.length) {
    const names = stalled.map((id) => stepLabels[id] || id).join(', ')
    return { status: 'failed', steps, output: terminalOutput(), error: `Flow has a cycle involving: ${names}. Flows must be acyclic.`, webhookResponse }
  }

  return { status: 'succeeded', steps, output: terminalOutput(), webhookResponse }
}
