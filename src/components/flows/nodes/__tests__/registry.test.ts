/**
 * The node-body registry's structural guarantees.
 *
 * The load-bearing one: ALL_TYPES must match the FlowNode union exactly, so a
 * new node type added to graph.ts fails here until it has a param surface —
 * rather than rendering an empty config panel in production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NODE_BODIES } from '../registry'

// Mirrors the discriminated union assembled at graph.ts:479. Listed explicitly
// rather than derived from NODE_BODIES' own keys: a test that reads its
// expectations off the thing under test proves nothing.
const ALL_TYPES = [
  'trigger', 'agent', 'code', 'condition', 'loop', 'parallel', 'stop', 'tool', 'http',
  'transform', 'filter', 'switch', 'variable', 'data', 'humanReview',
  'respondWebhook', 'wait', 'repeatUntil', 'input', 'output', 'subflow',
  'router', 'errorShield',
] as const

test('ALL_TYPES matches the FlowNode union exactly', () => {
  const registered = Object.keys(NODE_BODIES).sort()
  assert.deepEqual(registered, [...ALL_TYPES].sort())
})

test('every node type has a usable body module', () => {
  for (const type of ALL_TYPES) {
    const entry = NODE_BODIES[type]
    assert.ok(entry, `${type} has no registry entry`)
    assert.equal(typeof entry.Body, 'function', `${type}.Body is not a component`)
    assert.ok(Array.isArray(entry.requiredFields), `${type}.requiredFields must be an array`)
  }
})

test('requiredFields entries are non-empty strings', () => {
  for (const [type, entry] of Object.entries(NODE_BODIES)) {
    for (const field of entry!.requiredFields) {
      assert.equal(typeof field, 'string', `${type} has a non-string requiredField`)
      assert.ok(field.trim().length > 0, `${type} has a blank requiredField`)
    }
  }
})

test('condition and filter share one body module', () => {
  // They shared a single ConditionBody in the old switch; two copies would be
  // two places to fix a clause-editor bug.
  assert.equal(NODE_BODIES.condition, NODE_BODIES.filter)
})
