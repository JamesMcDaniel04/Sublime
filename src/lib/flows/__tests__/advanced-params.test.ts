import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advancedParamKeys, advancedParamsSetCount } from '../advanced-params'
import type { FlowNode } from '../graph'

test('each node type declares its advanced keys', () => {
  assert.deepEqual(advancedParamKeys('agent'), ['includeUpstream', 'onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'])
  assert.deepEqual(advancedParamKeys('tool'), ['excludeFromContext', 'forEachItem', 'onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'])
  assert.deepEqual(advancedParamKeys('loop'), ['concurrency', 'disabled'])
  assert.deepEqual(advancedParamKeys('trigger'), [])
  // transform and data now declare a fan-out; both previously fell through
  // to the default, which is exactly why forEachItem had nowhere to live.
  assert.deepEqual(advancedParamKeys('transform'), ['forEachItem', 'disabled'])
  assert.deepEqual(advancedParamKeys('data'), ['forEachItem', 'disabled'])
  // Every other type still gets at least the Execution on/off toggle.
  assert.deepEqual(advancedParamKeys('switch'), ['disabled'])
})

test('the http node opts out — it owns an n8n-style Options panel instead', () => {
  // Two panels over the same node meant two `bodyMode` selects with different
  // option sets, and the advanced one silently rewrote a GraphQL body to JSON.
  assert.deepEqual(advancedParamKeys('http'), [])
})

test('advancedParamsSetCount counts only explicitly-set params', () => {
  const bare: FlowNode = { id: 'n1', type: 'tool', data: { connectionId: 'c1', toolName: 'send' } }
  assert.equal(advancedParamsSetCount(bare), 0)
  const tuned: FlowNode = {
    id: 'n2',
    type: 'tool',
    data: { connectionId: 'c1', toolName: 'send', retries: 2, timeoutMs: 5000 },
  }
  assert.equal(advancedParamsSetCount(tuned), 2)
})

// ── forEachItem ─────────────────────────────────────────────────────────────
//
// The n8n-parity per-item fan-out. graph.ts declares it on tool, transform,
// data AND http (verified at runtime — `code` strips it), and interpret.ts
// acts on it in three places. It had NO control anywhere: built, executing,
// and impossible to turn on.
//
// It belongs in this manifest rather than in four hand-written toggles —
// which is also the smallest step toward declaring node params as data.

test('the per-item fan-out is offered on every node type that executes it', () => {
  for (const type of ['tool', 'transform', 'data'] as const) {
    assert.ok(
      advancedParamKeys(type).includes('forEachItem'),
      `${type} accepts forEachItem in graph.ts but does not offer it`,
    )
  }
})

// http is deliberately absent from BY_TYPE — it owns an Options / Add option
// panel, and listing it here once resurrected a bug where two panels edited
// bodyMode with different option sets. Its fan-out control belongs there.
test('http is still not routed through this manifest', () => {
  assert.deepEqual(advancedParamKeys('http'), [])
})

// A node type that cannot execute the flag must never advertise it.
test('code does not offer a fan-out it would silently drop', () => {
  assert.ok(!advancedParamKeys('code').includes('forEachItem'))
})
