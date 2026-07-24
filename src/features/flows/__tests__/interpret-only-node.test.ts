/**
 * Single-node test mode (`onlyNodeId`). The property that matters is NEGATIVE:
 * nothing except the selected node may run. A downstream write action firing
 * because someone tweaked a config field is the exact failure this mode exists
 * to prevent, so these assertions are about what DIDN'T execute.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunActionFn, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const http = (id: string, label: string, path: string) =>
  ({ id, type: 'http' as const, data: { label, method: 'GET' as const, url: `https://api/${path}` } })

/** Records every node the interpreter actually executed, and its resolved config. */
function recorder() {
  const ran: string[] = []
  const configs: Record<string, unknown> = {}
  const runAction: RunActionFn = async (node) => {
    ran.push(node.id)
    configs[node.id] = node.config
    return { output: { ok: true, id: node.id } }
  }
  // Agent steps also count as "ran" — the negative assertions cover them too.
  const runAgent: RunAgentFn = async (node) => {
    ran.push(node.id)
    return { output: `done:${node.id}` }
  }
  return { runAction, runAgent, ran, configs }
}

// trigger → a → b → c   ('c' stands in for any downstream write)
const chain: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    http('a', 'Fetch A', 'a'),
    http('b', 'Fetch B', 'b'),
    http('c', 'Delete everything', 'c'),
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'a' },
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ],
} as FlowGraph

test('onlyNodeId runs exactly the selected node', async () => {
  const { runAction, runAgent, ran } = recorder()
  const result = await interpretFlow(chain, 'go', { runAction, runAgent, onlyNodeId: 'b', completed: { a: { items: [1] } } })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['b'])
})

test('onlyNodeId runs NEITHER downstream nor upstream nodes', async () => {
  const { runAction, runAgent, ran } = recorder()
  await interpretFlow(chain, 'go', { runAction, runAgent, onlyNodeId: 'b', completed: { a: {} } })
  assert.equal(ran.includes('c'), false, 'a downstream step MUST NOT run')
  assert.equal(ran.includes('a'), false, 'an upstream step MUST NOT re-run either')
})

test('onlyNodeId resolves upstream tokens from seeded completed outputs', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      http('a', 'Fetch A', 'a'),
      { id: 'b', type: 'http', data: { label: 'Use A', method: 'GET' as const, url: 'https://api/{{step.a.output.slug}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
    ],
  } as FlowGraph
  const { runAction, runAgent, configs } = recorder()
  await interpretFlow(graph, 'go', { runAction, runAgent, onlyNodeId: 'b', completed: { a: { slug: 'widgets' } } })
  // The seeded output must be reachable through the same token path the
  // datatree emits — this is what makes "test with last run's data" honest.
  assert.match(String((configs.b as { url?: string }).url), /widgets/)
})

test('an unknown onlyNodeId does not silently run the whole flow', async () => {
  // Falling through to the trigger would promote a one-node test into a full
  // run — the worst available failure mode for this option.
  const { runAction, runAgent, ran } = recorder()
  const result = await interpretFlow(chain, 'go', { runAction, runAgent, onlyNodeId: 'ghost' }).catch(
    () => ({ status: 'failed' as const }),
  )
  assert.notEqual(result.status, 'succeeded')
  assert.deepEqual(ran, [])
})

test('a container node is refused rather than run empty', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input.items}}', body: [] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  } as unknown as FlowGraph
  const { runAction, runAgent, ran } = recorder()
  const result = await interpretFlow(graph, 'go', { runAction, runAgent, onlyNodeId: 'loop' }).catch((error: Error) => {
    assert.match(error.message, /steps inside it/i)
    return { status: 'failed' as const }
  })
  assert.notEqual(result.status, 'succeeded')
  assert.deepEqual(ran, [])
})
