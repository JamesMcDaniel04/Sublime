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
