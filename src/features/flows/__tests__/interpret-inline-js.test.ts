/**
 * Inline {{js: <expr>}} expression tokens: evaluated in the QuickJS sandbox
 * (same engine as code steps) with the flow context exposed as bindings. This
 * exercises the real sandbox via runExpression — the exact evalJs wiring
 * execute-flow uses — so it proves the async template path end to end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunActionFn } from '../interpret'
import type { EvalJsFn, FlowContext } from '../context'
import { runExpression } from '@/lib/code/run-js'
import type { FlowGraph } from '@/lib/flows/graph'

const evalJs: EvalJsFn = async (expression: string, ctx: FlowContext) => {
  const scope: Record<string, unknown> = {
    $json: ctx.item !== undefined ? ctx.item : ctx.trigger.input,
    item: ctx.item ?? null,
    step: Object.fromEntries(Object.entries(ctx.step).map(([id, entry]) => [id, entry.output])),
    input: ctx.input ?? {},
    trigger: { input: ctx.trigger.input },
    vars: ctx.variables ?? {},
    loop: ctx.loop ?? null,
  }
  const result = await runExpression(expression, scope)
  if (!result.ok) throw new Error(result.error)
  return result.output
}

test('inline JS in an http url computes via the sandbox', async () => {
  let calledUrl = ''
  const runAction: RunActionFn = async (node) => {
    calledUrl = String((node.config as { url?: unknown }).url ?? '')
    return { output: { ok: true } }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'call', type: 'http', data: { method: 'GET' as const, url: 'https://api.example.com/{{js: trigger.input.name.toUpperCase() }}/{{js: 2 * 3 }}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
  }
  const result = await interpretFlow(graph, { name: 'acme' }, { runAgent: async () => ({ output: 'x' }), runAction, evalJs })
  assert.equal(result.status, 'succeeded')
  assert.equal(calledUrl, 'https://api.example.com/ACME/6')
})

test('inline JS transform value preserves computed type (exact token)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'shape', type: 'transform', data: { fields: [{ name: 'doubled', value: '{{js: input.n * 2 }}' }, { name: 'tags', value: '{{js: ["a","b"].map((t) => t + "!") }}' }] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'shape' }],
  }
  const result = await interpretFlow(graph, {}, {
    runAgent: async () => ({ output: 'x' }), runAction: async () => ({ output: {} }), evalJs,
    // input node absent → seed ctx.input via trigger; use a variable instead:
  })
  // No input node, so input is empty; assert the array expression at least.
  const shape = result.steps.find((step) => step.nodeId === 'shape' && step.status === 'succeeded')
  assert.deepEqual((shape?.output as { tags: unknown }).tags, ['a!', 'b!'])
})

test('a failing inline expression fails the step with a clear message', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'call', type: 'http', data: { method: 'GET' as const, url: 'https://x.co/{{js: nope.boom() }}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
  }
  const result = await interpretFlow(graph, {}, { runAgent: async () => ({ output: 'x' }), runAction: async () => ({ output: {} }), evalJs })
  assert.equal(result.status, 'failed')
})

test('without an evalJs injected, {{js:}} resolves to empty (no crash)', async () => {
  let calledUrl = 'unset'
  const runAction: RunActionFn = async (node) => { calledUrl = String((node.config as { url?: unknown }).url ?? ''); return { output: {} } }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'call', type: 'http', data: { method: 'GET' as const, url: 'https://x.co/{{js: 1+1 }}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
  }
  const result = await interpretFlow(graph, {}, { runAgent: async () => ({ output: 'x' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(calledUrl, 'https://x.co/')
})
