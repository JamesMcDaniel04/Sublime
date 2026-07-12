import type { FlowGraph, FlowNode, FlowEdge, VariableType } from '@/lib/flows/graph'
import { resolveTemplate, resolveTemplateValue, asStructured, evalCondition, evalClause, type FlowContext } from './context'
import { shouldRetryAfterTimeout } from './action-reliability'
import { structuredResponseInstruction, parseStructuredAgentOutput } from './agent-response'
import { runDataOp } from '@/lib/flows/data-ops'
import { resolveInputParams, bindOutputFields } from '@/lib/flows/io-nodes'
import type { RouterBranchSpec } from '@/lib/flows/router'
import { joinBranchOutputs } from '@/lib/flows/join'

export type StepOutcome = {
  nodeId: string
  status: 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'stopped'
  output?: unknown
  error?: string
}
export type RunAgentResult = { output?: unknown; error?: string; waiting?: { status: string; question?: string } }
export type RunAgentFn = (node: { id: string; agentId: string; input: string; prompt?: string; model?: string; resume?: boolean; thread?: { key: string; iteration: number } }) => Promise<RunAgentResult>
// Deterministic (non-agent) steps: tool calls and HTTP requests. `config`
// arrives with every template already resolved against the flow context.
// `resume` marks the node a paused run is re-entering (e.g. after an approval
// decision) so the adapter can consume the decision instead of re-executing.
export type RunActionFn = (node: { id: string; kind: 'tool' | 'http'; config: Record<string, unknown>; resume?: boolean }) => Promise<RunAgentResult>
// Synchronous subflow: run a child flow to completion and block on its output.
// v1 is synchronous-only — a child that would itself pause is surfaced as a
// plain `error` (the execute-flow.ts adapter performs that translation), never
// a `waiting` result, so this contract has no waiting case to represent.
export type RunFlowResult = { output?: unknown; error?: string }
export type RunFlowFn = (node: { id: string; flowId: string; input: unknown; resume?: boolean }) => Promise<RunFlowResult>
// AI Router branch pick. Injected (like runAgent) so the interpreter stays
// pure: the execute-flow adapter wires this to a cheap generateStructured call.
export type RouteAiFn = (node: { id: string; branches: RouterBranchSpec[]; instructions?: string; input: string }) => Promise<{ branch: string } | { error: string }>
export type InterpretResult = {
  status: 'succeeded' | 'failed' | 'waiting'
  steps: StepOutcome[]
  output: unknown
  waiting?: { nodeId: string; question?: string }
  // Why a failed run failed — the failing node's error (e.g. the timeout
  // message) so callers can persist it on the run record.
  error?: string
}

type Opts = {
  runAgent: RunAgentFn
  runAction?: RunActionFn
  runFlow?: RunFlowFn
  routeAi?: RouteAiFn
  maxSteps?: number
  maxLoopIterations?: number
  onStep?: (outcome: StepOutcome) => void
  // Resume support: `completed` maps node ids already finished on a prior run to
  // their output (they are skipped, not re-run); `resumeNodeId` is the node that
  // was paused and should re-run with the user's reply injected.
  completed?: Record<string, unknown>
  resumeNodeId?: string
  // The user's reply for the resuming node. Agent steps receive the reply
  // inside their adapter (execute-flow re-enters the paused execution with
  // it); a humanReview step has no adapter, so the interpreter itself turns
  // this reply into the resuming step's output.
  resumeReply?: string
  // The webhook-derived payload for a webhook-triggered run — the secondary
  // source for input-node precedence (user > webhook > default). Absent for
  // manual/API/flow-as-tool runs, where the trigger input is the sole user source.
  webhookInput?: unknown
}

// Result of executing a single node — an output, or a control signal that
// propagates up through containers and halts the main chain.
type NodeResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'skip' }
  | { kind: 'stop' }
  | { kind: 'fail'; error: string }
  | { kind: 'pause'; nodeId: string; question?: string }
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

/**
 * Deterministically interpret a flow graph. Pure: agent execution is delegated
 * to `opts.runAgent`. Supports nested control flow (loops/parallels containing
 * containers), container-level fail/pause propagation, a stop node, retries,
 * per-step timeout, and full per-node outcome reporting via `opts.onStep`.
 */
export async function interpretFlow(graph: FlowGraph, input: unknown, opts: Opts): Promise<InterpretResult> {
  const maxSteps = opts.maxSteps ?? 100
  const maxLoop = opts.maxLoopIterations ?? 500
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
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
  let visits = 0
  const overBudget = () => ++visits > maxSteps

  // Run an agent with optional per-attempt timeout and retry-with-backoff.
  const runAgentWithReliability = async (
    node: Extract<FlowNode, { type: 'agent' }>,
    resolvedInput: string,
    extra: { prompt?: string; thread?: FlowContext['thread'] },
  ): Promise<RunAgentResult> => {
    const retries = node.data.retries ?? 0
    const timeoutMs = node.data.timeoutMs
    const resume = opts.resumeNodeId === node.id
    let attempt = 0
    for (;;) {
      const call = opts.runAgent({ id: node.id, agentId: node.data.agentId, input: resolvedInput, prompt: extra.prompt, model: node.data.model, resume, thread: extra.thread })
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

    if (node.type === 'trigger') return { kind: 'skip' }

    // Resume: a node finished on the prior run is reused, not re-executed.
    // Variable state was already reconstructed by the pre-walk replay (which
    // covers container bodies the walk never enters), so a replayed variable
    // step must NOT re-apply here — that would rewind the symbol table to a
    // value from before a later completed write.
    if (opts.completed && Object.prototype.hasOwnProperty.call(opts.completed, node.id)) {
      const output = opts.completed[node.id]
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'skipped', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'stop') {
      emit({ nodeId: node.id, status: 'stopped', output: node.data.reason ?? 'Flow stopped.' })
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
      emit({ nodeId: node.id, status: 'failed', error })
      return { kind: 'fail', error }
    }

    if (node.type === 'humanReview') {
      // Request information: a first-class pause with no agent involved.
      // Resuming this exact node? The reviewer's reply IS the step output.
      if (opts.resumeNodeId === node.id) {
        const output = opts.resumeReply ?? ''
        ctx.step[node.id] = { output }
        emit({ nodeId: node.id, status: 'succeeded', output })
        return { kind: 'ok', output }
      }
      // First visit: resolve the message and pause the run. The outcome carries
      // the same `{ waiting: { kind: 'input', question } }` shape the agent
      // adapter persists, so execute-flow's onStep path can store it verbatim
      // and the existing reply machinery renders/answers it unchanged.
      const question = resolveTemplate(node.data.message, ctx)
      emit({ nodeId: node.id, status: 'waiting', output: { waiting: { kind: 'input', question } } })
      return { kind: 'pause', nodeId: node.id, question }
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
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'variable') {
      const res = applyVariableOp(node, ctx, declaredTypes)
      if ('error' in res) {
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        return { kind: 'fail', error: res.error }
      }
      ctx.step[node.id] = { output: res.output }
      emit({ nodeId: node.id, status: 'succeeded', output: res.output })
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
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        return { kind: 'fail', error: res.error }
      }
      ctx.step[node.id] = { output: res.output }
      emit({ nodeId: node.id, status: 'succeeded', output: res.output })
      return { kind: 'ok', output: res.output }
    }

    if (node.type === 'filter') {
      // Gate: pass through when the condition holds; else drop (loop) / end (chain).
      const passed = evalCondition(node.data, ctx)
      if (passed) {
        emit({ nodeId: node.id, status: 'succeeded', output: true })
        return { kind: 'ok', output: undefined }
      }
      emit({ nodeId: node.id, status: 'skipped', output: false })
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
            }
          : {
              ...(node.data.connectionId ? { connectionId: node.data.connectionId } : {}),
              method: node.data.method,
              url: resolveTemplate(node.data.url, ctx),
              query: resolveConfigValue(node.data.query, ctx),
              headers: resolveConfigValue(node.data.headers, ctx),
              body: resolveConfigValue(node.data.body, ctx),
              bodyMode: node.data.bodyMode,
              responseType: node.data.responseType,
              failOnHttpError: node.data.failOnHttpError,
              retries: node.data.retries,
              timeoutMs: node.data.timeoutMs,
            }
      const res: RunAgentResult = opts.runAction
        ? await opts.runAction({ id: node.id, kind: node.type, config, resume: opts.resumeNodeId === node.id })
        : { error: `${node.type} steps are not supported in this runtime.` }
      if (res.waiting) {
        // A write tool queued for approval pauses the run, same as an agent step.
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: node.id, question: res.waiting.question }
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
      let resolved = resolveTemplate(node.data.input ?? '{{trigger.input}}', ctx)
      if (structured) resolved = `${resolved}\n\n${structuredResponseInstruction(outputFields)}`
      const inline = !node.data.agentId?.trim()
      const prompt = inline ? resolveTemplate(node.data.prompt ?? '', ctx) : undefined
      const res = await runAgentWithReliability(node, resolved, { prompt, thread: ctx.thread })
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
      // Synchronous subflow, v1: a child that would itself pause is never a
      // pause here — the adapter (execute-flow.ts's runFlow) translates a
      // child `waiting` result into a plain `error` before it ever reaches
      // this contract, so there is no `waiting` case to branch on. A subflow
      // can only ever end this node in `error` or success.
      const res: RunFlowResult = opts.runFlow
        ? await opts.runFlow({ id: node.id, flowId: node.data.flowId, input: childInput, resume: opts.resumeNodeId === node.id })
        : { error: 'Subflow steps are not supported in this runtime.' }
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
      const perItem = await mapLimit(items, node.data.concurrency ?? 1, async (item, index) => {
        // `variables` is shared by reference: writes inside the body persist
        // past the loop (one flow-global symbol table, MS parity).
        const itemCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item, loop: { index, count: items.length }, variables: ctx.variables, input: ctx.input }
        return execBody(node.data.body, itemCtx)
      })
      // Propagate the first hard control (stop / fail / pause); a 'drop' (filter)
      // just removes that item from the collected output.
      const control = perItem.map((r) => r.control).find((c): c is NodeResult => c !== undefined && c.kind !== 'drop')
      if (control) {
        emit({ nodeId: node.id, status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped' })
        return control
      }
      const output = perItem.filter((r) => r.control?.kind !== 'drop').map((r) => r.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'parallel') {
      const results = await Promise.all(
        node.data.branches.map(async (branch) => {
          const branchCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item: ctx.item, loop: ctx.loop, variables: ctx.variables, input: ctx.input }
          const res = await execBody(branch, branchCtx)
          return { key: branch[0] ?? node.id, res }
        }),
      )
      const control = results.map((r) => r.res.control).find((c): c is NodeResult => c !== undefined && c.kind !== 'drop')
      if (control) {
        emit({ nodeId: node.id, status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped' })
        return control
      }
      const entries = results
        .map((r, index) => ({ key: r.key, output: r.res.output, label: node.data.labels?.[index], dropped: r.res.control?.kind === 'drop' }))
        .filter((e) => !e.dropped)
      const output = joinBranchOutputs(entries, node.data.join)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
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
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )

  const ctx: FlowContext = { trigger: { input }, step: {}, variables: {} }

  // Resume: rebuild the symbol table from EVERY completed variable step before
  // walking. A completed loop/parallel short-circuits without entering its
  // body, so writes made inside container bodies would otherwise be lost.
  // `completed` preserves execution order (execute-flow builds it from step
  // rows ordered `order asc`), and each stored output IS the variable's
  // post-op value, so replay assigns outputs in that order — it never re-runs
  // the op — leaving the correct last write per name in place.
  if (opts.completed) {
    const variables = (ctx.variables ??= {})
    for (const [nodeId, output] of Object.entries(opts.completed)) {
      const node = byId.get(nodeId)
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
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]

  while (current) {
    if (current.type === 'condition') {
      if (overBudget()) return { status: 'failed', steps, output: lastOutput, error: 'Flow exceeded the maximum number of steps.' }
      const branch = evalCondition(current.data, ctx) ? 'true' : 'false'
      const edge = outgoing(current.id, branch)
      current = edge ? byId.get(edge.target) : undefined
      continue
    }

    if (current.type === 'switch') {
      if (overBudget()) return { status: 'failed', steps, output: lastOutput, error: 'Flow exceeded the maximum number of steps.' }
      // First matching case wins; otherwise follow the 'default' edge.
      const hit = current.data.cases.find((c) => evalClause({ left: c.left, op: c.op, right: c.right }, ctx))
      emit({ nodeId: current.id, status: 'succeeded', output: hit?.id ?? 'default' })
      const edge = outgoing(current.id, hit ? hit.id : 'default')
      current = edge ? byId.get(edge.target) : undefined
      continue
    }

    if (current.type === 'router') {
      if (overBudget()) return { status: 'failed', steps, output: lastOutput, error: 'Flow exceeded the maximum number of steps.' }
      let chosen: string
      // Resume stability: reuse the branch chosen on the first run (the stored
      // output IS the branch id). Re-calling the model could route differently.
      const prior = opts.completed && Object.prototype.hasOwnProperty.call(opts.completed, current.id) ? opts.completed[current.id] : undefined
      if (typeof prior === 'string' && prior) {
        chosen = prior
        emit({ nodeId: current.id, status: 'skipped', output: chosen })
      } else if (!opts.routeAi) {
        const error = 'Router steps need an AI runtime and are not supported in this runtime.'
        emit({ nodeId: current.id, status: 'failed', error })
        return { status: 'failed', steps, output: lastOutput, error }
      } else {
        const input = resolveTemplate(current.data.input ?? '{{trigger.input}}', ctx)
        const res = await opts.routeAi({ id: current.id, branches: current.data.branches, instructions: current.data.instructions, input })
        if ('error' in res) {
          emit({ nodeId: current.id, status: 'failed', error: res.error })
          return { status: 'failed', steps, output: lastOutput, error: res.error }
        }
        chosen = res.branch
        ctx.step[current.id] = { output: chosen }
        emit({ nodeId: current.id, status: 'succeeded', output: chosen })
      }
      const edge = outgoing(current.id, chosen)
      current = edge ? byId.get(edge.target) : undefined
      continue
    }

    const res = await execNode(current, ctx)
    if (res.kind === 'fail') return { status: 'failed', steps, output: lastOutput, error: res.error }
    if (res.kind === 'pause') return { status: 'waiting', steps, output: lastOutput, waiting: { nodeId: res.nodeId, question: res.question } }
    // A stop node or a main-chain filter that didn't pass ends the flow cleanly.
    if (res.kind === 'stop' || res.kind === 'drop') return { status: 'succeeded', steps, output: terminalOutput() }
    if (res.kind === 'ok' && res.output !== undefined) lastOutput = res.output

    const edge = outgoing(current.id)
    let next = edge ? byId.get(edge.target) : undefined
    while (next && contained.has(next.id)) {
      const skip = outgoing(next.id)
      next = skip ? byId.get(skip.target) : undefined
    }
    current = next
  }

  return { status: 'succeeded', steps, output: terminalOutput() }
}
