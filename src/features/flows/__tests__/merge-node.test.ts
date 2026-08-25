/**
 * Merge through the real interpreter.
 *
 * `runMerge` is unit-tested over literal branches; this is the leg those tests
 * cannot cover — that a flow with two parents actually reaches the node with
 * both outputs in hand, and that source selection does not depend on edge
 * insertion order.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const runAgent = async () => ({ output: 'unused' })

/** Two code steps feeding one merge. */
const graphWith = (mergeData: Record<string, unknown>): FlowGraph =>
  ({
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { triggerType: 'manual' } },
      { id: 'left', type: 'code', position: { x: 0, y: 1 }, data: { code: 'x', language: 'javascript' } },
      { id: 'right', type: 'code', position: { x: 1, y: 1 }, data: { code: 'y', language: 'javascript' } },
      { id: 'm', type: 'merge', position: { x: 0, y: 2 }, data: mergeData },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'left' },
      { id: 'e2', source: 't', target: 'right' },
      { id: 'e3', source: 'left', target: 'm' },
      { id: 'e4', source: 'right', target: 'm' },
    ],
  }) as unknown as FlowGraph

// Each code step returns a fixed list, keyed by node id.
// RunCodeFn receives `id`, not `nodeId` — the branch each step stands for.
// CodeRunOutcome is a DISCRIMINATED UNION: without `ok: true` the interpreter
// reads the outcome as a failure, and the merge is never reached. `logs` is
// required on both arms.
const runCode = async ({ id }: { id: string }) =>
  id === 'left'
    ? { ok: true as const, output: [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'Bolt' }], logs: [] }
    : { ok: true as const, output: [{ id: 'a', mrr: 100 }], logs: [] }

const run = async (mergeData: Record<string, unknown>) =>
  interpretFlow(graphWith(mergeData), null, { runAgent, runCode: runCode as never })

test('append joins both branches end to end', async () => {
  const result = await run({ mode: 'append' })
  const output = result.steps?.find((step) => step.nodeId === 'm')?.output as unknown[]
  assert.equal(output.length, 3)
})

test('an inner join on a field matches across branches', async () => {
  const result = await run({ mode: 'byKey', leftKey: 'id', join: 'inner' })
  const output = result.steps?.find((step) => step.nodeId === 'm')?.output as Record<string, unknown>[]
  assert.equal(output.length, 1)
  assert.equal(output[0].name, 'Acme')
  assert.equal(output[0].mrr, 100)
})

test('a left join keeps the unmatched row from the first branch', async () => {
  const result = await run({ mode: 'byKey', leftKey: 'id', join: 'left' })
  const output = result.steps?.find((step) => step.nodeId === 'm')?.output as unknown[]
  assert.equal(output.length, 2)
})

// The reason leftSource/rightSource exist: edge order is invisible in the
// builder, so a join must not silently depend on which edge was drawn first.
test('explicit sources decide the sides regardless of edge order', async () => {
  const result = await run({ mode: 'byKey', leftKey: 'id', rightKey: 'id', join: 'left', leftSource: 'right', rightSource: 'left' })
  const output = result.steps?.find((step) => step.nodeId === 'm')?.output as unknown[]
  // With the sides swapped, the single-row branch is now the left one, so a
  // left join yields one row rather than two.
  assert.equal(output.length, 1)
})

test('a misconfigured merge fails the step instead of returning nothing', async () => {
  const result = await run({ mode: 'byKey' })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /field to join on/i)
})
