/**
 * DAG engine ① — the capabilities the old single-chain walker could not express:
 * fan-out, fan-in/joins (run-once, resilient to a failed feeder), branch pruning
 * with re-convergence, concurrency, and cycle detection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const apiAction: RunActionFn = async (node) => {
  const url = String((node.config as { url?: unknown }).url ?? '')
  if (url.includes('boom')) return { error: 'HTTP 500: boom' }
  return { output: { ok: true, body: url.split('/').pop() } }
}

function recorder() {
  const ran: string[] = []
  const seen: Record<string, string> = {}
  const runAgent: RunAgentFn = async (node) => {
    ran.push(node.id)
    seen[node.id] = node.input
    return { output: `done:${node.id}` }
  }
  return { runAgent, ran, seen }
}

const http = (id: string, label: string, path: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'http' as const, data: { label, method: 'GET' as const, url: `https://api/${path}`, ...extra } })

test('fan-out: one node feeds two agents, both run', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      http('api', 'API', 'alpha'),
      { id: 'agentA', type: 'agent', data: { agentId: 'a' } },
      { id: 'agentB', type: 'agent', data: { agentId: 'b' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'api' },
      { id: 'e1', source: 'api', target: 'agentA' },
      { id: 'e2', source: 'api', target: 'agentB' },
    ],
  }
  const { runAgent, ran } = recorder()
  const result = await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran.sort(), ['agentA', 'agentB'])
})

test('fan-in: three APIs converge on ONE agent — it runs once with all three', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      http('a1', 'One', 'one'), http('a2', 'Two', 'two'), http('a3', 'Three', 'three'),
      { id: 'agent', type: 'agent', data: { agentId: 'a' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a1' },
      { id: 'e1', source: 'trigger', target: 'a2' },
      { id: 'e2', source: 'trigger', target: 'a3' },
      { id: 'e3', source: 'a1', target: 'agent' },
      { id: 'e4', source: 'a2', target: 'agent' },
      { id: 'e5', source: 'a3', target: 'agent' },
    ],
  }
  const { runAgent, ran, seen } = recorder()
  const result = await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['agent'], 'join runs exactly once, not once per parent')
  for (const body of ['one', 'two', 'three']) assert.match(seen.agent ?? '', new RegExp(body))
})

test('diamond: A→B, A→C, B→D, C→D runs D exactly once', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      http('a', 'A', 'a'), http('b', 'B', 'b'), http('c', 'C', 'c'),
      { id: 'd', type: 'agent', data: { agentId: 'd' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'a', target: 'c' },
      { id: 'e3', source: 'b', target: 'd' },
      { id: 'e4', source: 'c', target: 'd' },
    ],
  }
  const { runAgent, ran } = recorder()
  const result = await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['d'])
})

test('resilient join: a failed-and-continued feeder still lets the agent run with partial data', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      http('ok1', 'Good API', 'good'),
      http('bad', 'Bad API', 'boom', { onError: 'continue' }),
      { id: 'agent', type: 'agent', data: { agentId: 'a' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'ok1' },
      { id: 'e1', source: 'trigger', target: 'bad' },
      { id: 'e2', source: 'ok1', target: 'agent' },
      { id: 'e3', source: 'bad', target: 'agent' },
    ],
  }
  const { runAgent, ran, seen } = recorder()
  const result = await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['agent'])
  assert.match(seen.agent ?? '', /good/, 'sees the successful feeder')
  assert.match(seen.agent ?? '', /"ok":false/, 'sees the failed feeder as a recorded failure')
})

test('a stop-failing feeder aborts before the join', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      http('bad', 'Bad API', 'boom'), // default onError = stop
      { id: 'agent', type: 'agent', data: { agentId: 'a' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'bad' },
      { id: 'e1', source: 'bad', target: 'agent' },
    ],
  }
  const { runAgent, ran } = recorder()
  const result = await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })
  assert.equal(result.status, 'failed')
  assert.deepEqual(ran, [], 'the join never runs')
})

test('branch pruning: the untaken subtree never runs, and re-convergence runs once', async () => {
  // condition ─true→ hi ─┐
  //           ─false→ lo ┴→ merge   (merge must run exactly once)
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'cond', type: 'condition', data: { clauses: [{ left: '{{trigger.input}}', op: 'eq', right: 'yes' }] } },
      { id: 'hi', type: 'agent', data: { agentId: 'hi' } },
      { id: 'lo', type: 'agent', data: { agentId: 'lo' } },
      { id: 'merge', type: 'agent', data: { agentId: 'm' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'cond' },
      { id: 'e1', source: 'cond', target: 'hi', branch: 'true' },
      { id: 'e2', source: 'cond', target: 'lo', branch: 'false' },
      { id: 'e3', source: 'hi', target: 'merge' },
      { id: 'e4', source: 'lo', target: 'merge' },
    ],
  }
  const { runAgent, ran } = recorder()
  const result = await interpretFlow(graph, 'yes', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['hi', 'merge'], 'lo is pruned; merge still runs exactly once')
})

test('independent branches execute concurrently', async () => {
  let active = 0
  let maxActive = 0
  const runAgent: RunAgentFn = async (node) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active -= 1
    return { output: node.id }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'x', type: 'agent', data: { agentId: 'x' } },
      { id: 'y', type: 'agent', data: { agentId: 'y' } },
      { id: 'z', type: 'agent', data: { agentId: 'z' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'x' },
      { id: 'e1', source: 'trigger', target: 'y' },
      { id: 'e2', source: 'trigger', target: 'z' },
    ],
  }
  const result = await interpretFlow(graph, 'go', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.ok(maxActive >= 2, `independent nodes overlapped (max concurrent = ${maxActive})`)
})

test('maxConcurrency caps parallelism', async () => {
  let active = 0
  let maxActive = 0
  const runAgent: RunAgentFn = async (node) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active -= 1
    return { output: node.id }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'x', type: 'agent', data: { agentId: 'x' } },
      { id: 'y', type: 'agent', data: { agentId: 'y' } },
      { id: 'z', type: 'agent', data: { agentId: 'z' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'x' },
      { id: 'e1', source: 'trigger', target: 'y' },
      { id: 'e2', source: 'trigger', target: 'z' },
    ],
  }
  await interpretFlow(graph, 'go', { runAgent, maxConcurrency: 1 })
  assert.equal(maxActive, 1, 'maxConcurrency:1 forces sequential execution')
})

test('a cycle fails loudly instead of silently skipping nodes', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'a', label: 'Node A' } },
      { id: 'b', type: 'agent', data: { agentId: 'b', label: 'Node B' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' }, // cycle
    ],
  }
  const { runAgent } = recorder()
  const result = await interpretFlow(graph, 'go', { runAgent })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /cycle/i)
})
