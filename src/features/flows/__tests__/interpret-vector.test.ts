/**
 * The Vector step through the interpreter.
 *
 * The store tests cover the SQL; these cover the step: that its config reaches
 * the adapter with tokens resolved, that a failure becomes a step failure
 * rather than escaping, and that a flow without the adapter refuses rather
 * than silently doing nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow } from '../interpret'

const graphWith = (data: Record<string, unknown>) => ({
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'search', type: 'vector', data: { collection: 'tickets', ...data } },
  ],
  edges: [{ id: 'e0', source: 'trigger', target: 'search' }],
})

test('a search step reaches the adapter with its tokens resolved', async () => {
  let seen: { collection?: string; query?: string } = {}
  const result = await interpretFlow(
    graphWith({ mode: 'search', query: 'about {{trigger.input.topic}}' }) as never,
    { topic: 'billing' },
    {
      runAgent: async () => ({ output: '' }),
      runVector: async (step: { collection?: string; query?: string }) => { seen = step; return { ok: true, output: [{ content: 'a hit' }] } },
    } as never,
  )
  assert.equal(result.status, 'succeeded', `the run failed: ${result.error}`)
  assert.equal(seen.query, 'about billing', 'the query token was not resolved')
  assert.equal(seen.collection, 'tickets')
})

test('the hits become the step output', async () => {
  const result = await interpretFlow(
    graphWith({ mode: 'search', query: 'anything' }) as never,
    {},
    {
      runAgent: async () => ({ output: '' }),
      runVector: async () => ({ ok: true, output: [{ content: 'a hit', score: 0.9 }] }),
    } as never,
  )
  assert.deepEqual(result.output, [{ content: 'a hit', score: 0.9 }])
})

// An adapter failure must fail the STEP, so the flow's onError policy applies
// and the failure is attributed to a node rather than escaping the run.
test('an adapter failure fails the step', async () => {
  const result = await interpretFlow(
    graphWith({ mode: 'search', query: 'anything' }) as never,
    {},
    {
      runAgent: async () => ({ output: '' }),
      runVector: async () => ({ ok: false, error: 'the embedding provider is down' }),
    } as never,
  )
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /embedding provider is down/)
})

// A context with no adapter (a preview, a validation pass) must refuse rather
// than report success for a step that did nothing.
test('a flow with no vector adapter refuses rather than doing nothing', async () => {
  const result = await interpretFlow(
    graphWith({ mode: 'search', query: 'anything' }) as never,
    {},
    { runAgent: async () => ({ output: '' }) } as never,
  )
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /not available/i)
})

test('an upsert passes its documents through', async () => {
  let seen: unknown
  await interpretFlow(
    graphWith({ mode: 'upsert', documents: '{{trigger.input.rows}}', idField: 'sku' }) as never,
    { rows: [{ sku: 'a1', content: 'a widget' }] },
    {
      runAgent: async () => ({ output: '' }),
      runVector: async (step: { documents?: unknown }) => { seen = step.documents; return { ok: true, output: { written: 1 } } },
    } as never,
  )
  assert.deepEqual(seen, [{ sku: 'a1', content: 'a widget' }], 'the documents did not resolve to a list')
})
