/**
 * forEachItem — n8n-parity fan-out on http/tool steps: the step runs once per
 * item of its predecessor's list output (templates see each item as
 * {{item.…}}), and the step's output is the collected array. A non-list input
 * degrades to a single iteration, so the flag is safe on single-item chains.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const graphWith = (httpExtra: Record<string, unknown>): FlowGraph => ({
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    {
      id: 'list', type: 'data',
      data: { op: 'parseJson', input: '[{"callId":"c1"},{"callId":"c2"},{"callId":"c3"}]' },
    },
    { id: 'fetch', type: 'http', data: { method: 'GET' as const, url: 'https://api.example.com/calls/{{item.callId}}', forEachItem: true, ...httpExtra } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'list' },
    { id: 'e1', source: 'list', target: 'fetch' },
  ],
})

test('forEachItem runs the step once per input item and collects outputs', async () => {
  const urls: string[] = []
  const runAction: RunActionFn = async (node) => {
    const url = String((node.config as { url?: unknown }).url ?? '')
    urls.push(url)
    return { output: { transcript: `for ${url.split('/').pop()}` } }
  }
  const result = await interpretFlow(graphWith({}), 'go', { runAgent: async () => ({ output: 'x' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(urls, [
    'https://api.example.com/calls/c1',
    'https://api.example.com/calls/c2',
    'https://api.example.com/calls/c3',
  ])
  const fetchStep = result.steps.find((step) => step.nodeId === 'fetch' && step.status === 'succeeded')
  assert.deepEqual(fetchStep?.output, [
    { transcript: 'for c1' },
    { transcript: 'for c2' },
    { transcript: 'for c3' },
  ])
})

test('forEachItem over a single object degrades to one iteration', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'one', type: 'transform', data: { fields: [{ name: 'callId', value: 'solo' }] } },
      { id: 'fetch', type: 'http', data: { method: 'GET' as const, url: 'https://api.example.com/calls/{{item.callId}}', forEachItem: true } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'one' },
      { id: 'e1', source: 'one', target: 'fetch' },
    ],
  }
  const urls: string[] = []
  const runAction: RunActionFn = async (node) => {
    urls.push(String((node.config as { url?: unknown }).url ?? ''))
    return { output: { ok: true } }
  }
  const result = await interpretFlow(graph, 'go', { runAgent: async () => ({ output: 'x' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(urls, ['https://api.example.com/calls/solo'])
})

test('a failing item names its position and honors onError continue', async () => {
  const failSecond: RunActionFn = async (node) => {
    const url = String((node.config as { url?: unknown }).url ?? '')
    return url.endsWith('c2') ? { error: 'HTTP 500' } : { output: { ok: true } }
  }
  const strict = await interpretFlow(graphWith({}), 'go', { runAgent: async () => ({ output: 'x' }), runAction: failSecond })
  assert.equal(strict.status, 'failed')
  assert.match(strict.error ?? '', /Item 2 of 3/)

  const lenient = await interpretFlow(graphWith({ onError: 'continue' }), 'go', { runAgent: async () => ({ output: 'x' }), runAction: failSecond })
  assert.equal(lenient.status, 'succeeded')
})

test('forEachItem caps runaway fan-out with a clear error', async () => {
  const big = JSON.stringify(Array.from({ length: 501 }, (_unused, index) => ({ callId: `c${index}` })))
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'list', type: 'data', data: { op: 'parseJson', input: big } },
      { id: 'fetch', type: 'http', data: { method: 'GET' as const, url: 'https://api.example.com/{{item.callId}}', forEachItem: true } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'fetch' },
    ],
  }
  const result = await interpretFlow(graph, 'go', { runAgent: async () => ({ output: 'x' }), runAction: async () => ({ output: {} }) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /limit is 500/)
})

test('transform forEachItem builds one object per item', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'list', type: 'data', data: { op: 'parseJson', input: '[{"name":"ada"},{"name":"grace"}]' } },
      { id: 'shape', type: 'transform', data: { forEachItem: true, fields: [{ name: 'upper', value: '{{item.name}}' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'shape' },
    ],
  }
  const result = await interpretFlow(graph, 'go', { runAgent: async () => ({ output: 'x' }), runAction: async () => ({ output: {} }) })
  assert.equal(result.status, 'succeeded')
  const shape = result.steps.find((step) => step.nodeId === 'shape' && step.status === 'succeeded')
  assert.deepEqual(shape?.output, [{ upper: 'ada' }, { upper: 'grace' }])
})

test('filter splitItems keeps matching items and continues on empty', async () => {
  const graphFor = (right: string): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'list', type: 'data', data: { op: 'parseJson', input: '[{"score":9},{"score":2},{"score":7}]' } },
      { id: 'keep', type: 'filter', data: { splitItems: true, clauses: [{ left: '{{item.score}}', op: 'gt', right }] } },
      { id: 'after', type: 'transform', data: { fields: [{ name: 'done', value: 'yes' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'keep' },
      { id: 'e2', source: 'keep', target: 'after' },
    ],
  })
  const result = await interpretFlow(graphFor('5'), 'go', { runAgent: async () => ({ output: 'x' }), runAction: async () => ({ output: {} }) })
  assert.equal(result.status, 'succeeded')
  const keep = result.steps.find((step) => step.nodeId === 'keep' && step.status === 'succeeded')
  assert.deepEqual(keep?.output, [{ score: 9 }, { score: 7 }])
  // Zero matches: the flow CONTINUES with [] instead of dropping the branch.
  const none = await interpretFlow(graphFor('100'), 'go', { runAgent: async () => ({ output: 'x' }), runAction: async () => ({ output: {} }) })
  assert.equal(none.status, 'succeeded')
  assert.ok(none.steps.some((step) => step.nodeId === 'after' && step.status === 'succeeded'))
})

test('condition splitItems routes both branches when items land on both sides', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'list', type: 'data', data: { op: 'parseJson', input: '[{"score":9},{"score":2}]' } },
      { id: 'route', type: 'condition', data: { splitItems: true, clauses: [{ left: '{{item.score}}', op: 'gt', right: '5' }] } },
      { id: 'hot', type: 'transform', data: { fields: [{ name: 'kind', value: 'hot' }] } },
      { id: 'cold', type: 'transform', data: { fields: [{ name: 'kind', value: 'cold' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'route' },
      { id: 'e2', source: 'route', target: 'hot', branch: 'true' },
      { id: 'e3', source: 'route', target: 'cold', branch: 'false' },
    ],
  }
  const result = await interpretFlow(graph, 'go', { runAgent: async () => ({ output: 'x' }), runAction: async () => ({ output: {} }) })
  assert.equal(result.status, 'succeeded')
  // BOTH branches ran — n8n item-routing semantics, not either/or.
  assert.ok(result.steps.some((step) => step.nodeId === 'hot' && step.status === 'succeeded'))
  assert.ok(result.steps.some((step) => step.nodeId === 'cold' && step.status === 'succeeded'))
})

test('wait until webhook parks the run for an external callback', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'hold', type: 'wait', data: { amount: 1, unit: 'seconds', until: 'webhook' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'hold' }],
  }
  const result = await interpretFlow(graph, 'go', { runAgent: async () => ({ output: 'x' }), runAction: async () => ({ output: {} }) })
  assert.equal(result.status, 'waiting')
  const waitingStep = result.steps.find((step) => step.nodeId === 'hold' && step.status === 'waiting')
  assert.ok(waitingStep, 'expected the wait step to be parked')
  assert.match(JSON.stringify(waitingStep?.output), /webhook callback/)
})
