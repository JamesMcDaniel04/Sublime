import type { FlowGraph, FlowNode, FlowEdge } from '@/lib/flows/graph'
import { resolveTemplate, asStructured, evalCondition, type FlowContext } from './context'

export type StepOutcome = {
  nodeId: string
  status: 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'stopped'
  output?: unknown
  error?: string
}
export type RunAgentResult = { output?: unknown; error?: string; waiting?: { status: string; question?: string } }
export type RunAgentFn = (node: { id: string; agentId: string; input: string; resume?: boolean }) => Promise<RunAgentResult>
// Deterministic (non-agent) steps: MCP tool calls and HTTP requests. `config`
// arrives with every template already resolved against the flow context.
export type RunActionFn = (node: { id: string; kind: 'tool' | 'http'; config: Record<string, unknown> }) => Promise<RunAgentResult>
export type InterpretResult = {
  status: 'succeeded' | 'failed' | 'waiting'
  steps: StepOutcome[]
  output: unknown
  waiting?: { nodeId: string; question?: string }
}

type Opts = {
  runAgent: RunAgentFn
  runAction?: RunActionFn
  maxSteps?: number
  maxLoopIterations?: number
  onStep?: (outcome: StepOutcome) => void
  // Resume support: `completed` maps node ids already finished on a prior run to
  // their output (they are skipped, not re-run); `resumeNodeId` is the node that
  // was paused and should re-run with the user's reply injected.
  completed?: Record<string, unknown>
  resumeNodeId?: string
}

// Result of executing a single node — an output, or a control signal that
// propagates up through containers and halts the main chain.
type NodeResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'skip' }
  | { kind: 'stop' }
  | { kind: 'fail'; error: string }
  | { kind: 'pause'; nodeId: string; question?: string }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  const outgoing = (id: string, branch?: 'true' | 'false'): FlowEdge | undefined =>
    graph.edges.find((edge) => edge.source === id && (branch === undefined || edge.branch === branch || edge.branch === undefined))

  const steps: StepOutcome[] = []
  const emit = (outcome: StepOutcome) => {
    steps.push(outcome)
    opts.onStep?.(outcome)
  }
  let visits = 0
  const overBudget = () => ++visits > maxSteps

  // Run an agent with optional per-attempt timeout and retry-with-backoff.
  const runAgentWithReliability = async (
    node: Extract<FlowNode, { type: 'agent' }>,
    resolvedInput: string,
  ): Promise<RunAgentResult> => {
    const retries = node.data.retries ?? 0
    const timeoutMs = node.data.timeoutMs
    const resume = opts.resumeNodeId === node.id
    let attempt = 0
    for (;;) {
      const call = opts.runAgent({ id: node.id, agentId: node.data.agentId, input: resolvedInput, resume })
      const res: RunAgentResult = timeoutMs
        ? await Promise.race([call, sleep(timeoutMs).then((): RunAgentResult => ({ error: `Step timed out after ${timeoutMs}ms` }))])
        : await call
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

    if (node.type === 'condition') {
      // Conditions route on the main chain; inside a body they cannot branch.
      return { kind: 'skip' }
    }

    if (node.type === 'tool' || node.type === 'http') {
      // Resolve every template in the node config, then delegate to runAction.
      const config: Record<string, unknown> =
        node.type === 'tool'
          ? {
              connectionId: node.data.connectionId,
              toolName: node.data.toolName,
              args: resolveTemplate(node.data.args ?? '{}', ctx),
            }
          : {
              method: node.data.method,
              url: resolveTemplate(node.data.url, ctx),
              headers: node.data.headers ? resolveTemplate(node.data.headers, ctx) : undefined,
              body: node.data.body ? resolveTemplate(node.data.body, ctx) : undefined,
            }
      const res: RunAgentResult = opts.runAction
        ? await opts.runAction({ id: node.id, kind: node.type, config })
        : { error: `${node.type} steps are not supported in this runtime.` }
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

    if (node.type === 'agent') {
      const resolved = resolveTemplate(node.data.input ?? '{{trigger.input}}', ctx)
      const res = await runAgentWithReliability(node, resolved)
      if (res.waiting) {
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

    if (node.type === 'loop') {
      const list = asStructured(resolveTemplate(node.data.over, ctx))
      const items = Array.isArray(list) ? list.slice(0, maxLoop) : []
      const perItem = await mapLimit(items, node.data.concurrency ?? 1, async (item, index) => {
        const itemCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item, loop: { index, count: items.length } }
        return execBody(node.data.body, itemCtx)
      })
      // Propagate the first control signal (stop / fail / pause) from any item.
      const control = perItem.map((r) => r.control).find((c): c is NodeResult => Boolean(c))
      if (control) {
        emit({ nodeId: node.id, status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped' })
        return control
      }
      const output = perItem.map((r) => r.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'parallel') {
      const results = await Promise.all(
        node.data.branches.map(async (branch) => {
          const branchCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item: ctx.item, loop: ctx.loop }
          const res = await execBody(branch, branchCtx)
          return { key: branch[0] ?? node.id, res }
        }),
      )
      const control = results.map((r) => r.res.control).find((c): c is NodeResult => Boolean(c))
      if (control) {
        emit({ nodeId: node.id, status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped' })
        return control
      }
      const output = Object.fromEntries(results.map((r) => [r.key, r.res.output]))
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

  const ctx: FlowContext = { trigger: { input }, step: {} }
  let lastOutput: unknown = input
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]

  while (current) {
    if (current.type === 'condition') {
      if (overBudget()) return { status: 'failed', steps, output: lastOutput }
      const branch = evalCondition(current.data, ctx) ? 'true' : 'false'
      const edge = outgoing(current.id, branch)
      current = edge ? byId.get(edge.target) : undefined
      continue
    }

    const res = await execNode(current, ctx)
    if (res.kind === 'fail') return { status: 'failed', steps, output: lastOutput }
    if (res.kind === 'pause') return { status: 'waiting', steps, output: lastOutput, waiting: { nodeId: res.nodeId, question: res.question } }
    if (res.kind === 'stop') return { status: 'succeeded', steps, output: lastOutput }
    if (res.kind === 'ok' && res.output !== undefined) lastOutput = res.output

    const edge = outgoing(current.id)
    let next = edge ? byId.get(edge.target) : undefined
    while (next && contained.has(next.id)) {
      const skip = outgoing(next.id)
      next = skip ? byId.get(skip.target) : undefined
    }
    current = next
  }

  return { status: 'succeeded', steps, output: lastOutput }
}
