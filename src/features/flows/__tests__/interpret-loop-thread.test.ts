import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

function graph(threadAgent: boolean, concurrency?: number): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', threadAgent, concurrency, body: ['a'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'Process {{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
}

test('threaded loop passes a stable thread key + incrementing iteration', async () => {
  const seen: ({ key: string; iteration: number } | undefined)[] = []
  const runAgent: RunAgentFn = async (node) => { seen.push(node.thread); return { output: node.input } }
  await interpretFlow(graph(true), ['a', 'b', 'c'], { runAgent })
  assert.deepEqual(seen.map((t) => t?.iteration), [0, 1, 2])
  assert.equal(new Set(seen.map((t) => t?.key)).size, 1)
})

test('threaded loop runs sequentially even if concurrency is set high', async () => {
  let active = 0, maxActive = 0
  const runAgent: RunAgentFn = async (node) => {
    active += 1; maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 5))
    active -= 1
    return { output: node.input }
  }
  await interpretFlow(graph(true, 5), ['a', 'b', 'c'], { runAgent })
  assert.equal(maxActive, 1)
})

test('BACK-COMPAT: unthreaded loop passes no thread', async () => {
  const seen: unknown[] = []
  const runAgent: RunAgentFn = async (node) => { seen.push(node.thread); return { output: node.input } }
  await interpretFlow(graph(false), ['a', 'b'], { runAgent })
  assert.deepEqual(seen, [undefined, undefined])
})
