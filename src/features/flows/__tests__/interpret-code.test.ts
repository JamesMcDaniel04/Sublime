/**
 * The code node's interpreter dispatch. The interpreter stays pure: it
 * resolves the items, calls the injected `opts.runCode`, and shapes the
 * outcome — the vm/pyodide engines live behind that seam (execute-flow wires
 * the real ones), so these tests need no sandbox at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunCodeFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echoAgent = async () => ({ output: 'unused' })

const graphWith = (data: Record<string, unknown>, upstream?: Record<string, unknown>): FlowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', data: {} },
    ...(upstream ? [{ id: 'up', type: 'transform', data: { fields: [{ name: 'n', value: upstream.value }] } }] : []),
    { id: 'c1', type: 'code', data: { language: 'javascript', mode: 'allItems', code: 'return 1', ...data } },
  ],
  edges: upstream
    ? [{ id: 'e1', source: 't', target: 'up' }, { id: 'e2', source: 'up', target: 'c1' }]
    : [{ id: 'e1', source: 't', target: 'c1' }],
} as FlowGraph)

test('dispatches to runCode with the upstream output as items', async () => {
  const calls: Array<Parameters<RunCodeFn>[0]> = []
  const runCode: RunCodeFn = async (params) => {
    calls.push(params)
    return { ok: true, output: 'ran', logs: [] }
  }
  const result = await interpretFlow(graphWith({}, { value: '41' }), 'go', { runAgent: echoAgent, runCode })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].language, 'javascript')
  assert.equal(calls[0].code, 'return 1')
  // The transform's output object arrives as the single item.
  assert.deepEqual(calls[0].items, [{ n: 41 }])
})

test('an array upstream becomes the item list', async () => {
  const calls: Array<Parameters<RunCodeFn>[0]> = []
  const runCode: RunCodeFn = async (params) => { calls.push(params); return { ok: true, output: null, logs: [] } }
  const graph = graphWith({}, { value: '[1, 2, 3]' })
  // transform stores {n: [1,2,3]} — point the code node's input at the array itself.
  ;(graph.nodes[2].data as Record<string, unknown>).input = '{{step.up.output.n}}'
  await interpretFlow(graph, 'go', { runAgent: echoAgent, runCode })
  assert.deepEqual(calls[0].items, [1, 2, 3])
})

test('eachItem mode runs once per item and collects the outputs', async () => {
  const seen: unknown[] = []
  const runCode: RunCodeFn = async (params) => {
    seen.push(params.item)
    return { ok: true, output: `out:${JSON.stringify(params.item)}`, logs: [] }
  }
  const graph = graphWith({ mode: 'eachItem' }, { value: '[10, 20]' })
  ;(graph.nodes[2].data as Record<string, unknown>).input = '{{step.up.output.n}}'
  const result = await interpretFlow(graph, 'go', { runAgent: echoAgent, runCode })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(seen, [10, 20])
  const each = result.steps.find((step) => step.nodeId === 'c1' && step.status === 'succeeded')
  assert.deepEqual(each?.output, ['out:10', 'out:20'])
})

test('a failed run fails the step with the engine error', async () => {
  const runCode: RunCodeFn = async () => ({ ok: false, error: 'NameError: nope', logs: ['partial'] })
  const result = await interpretFlow(graphWith({}), 'go', { runAgent: echoAgent, runCode })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /NameError: nope/)
})

test('code steps without a wired runCode fail cleanly rather than hanging', async () => {
  const result = await interpretFlow(graphWith({}), 'go', { runAgent: echoAgent })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /not available/i)
})

test('the code node output lands in step context for downstream tokens', async () => {
  const runCode: RunCodeFn = async () => ({ ok: true, output: { total: 99 }, logs: [] })
  const result = await interpretFlow(graphWith({}), 'go', { runAgent: echoAgent, runCode })
  const done = result.steps.find((step) => step.nodeId === 'c1' && step.status === 'succeeded')
  assert.deepEqual(done?.output, { total: 99 })
})
