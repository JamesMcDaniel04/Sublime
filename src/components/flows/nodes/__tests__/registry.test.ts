/**
 * The node-body registry's structural guarantees.
 *
 * The important one arrives once every body has moved: ALL_TYPES must match the
 * FlowNode union exactly, so a new node type added to graph.ts fails here until
 * it has a param surface — rather than rendering an empty config panel in
 * production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NODE_BODIES } from '../registry'

// Grows to the full union as bodies move. Listed explicitly rather than derived
// from NODE_BODIES' own keys: a test that reads its expectations off the thing
// under test proves nothing.
const MOVED_SO_FAR = [
  'respondWebhook', 'wait', 'subflow', 'stop',
  'condition', 'filter', 'transform', 'loop', 'parallel', 'switch',
  'router', 'errorShield', 'repeatUntil', 'input', 'output',
] as const

test('every moved node type has a body module', () => {
  for (const type of MOVED_SO_FAR) {
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

test('registry holds exactly the types moved so far', () => {
  // Catches a module added to the registry but forgotten in MOVED_SO_FAR (and
  // vice versa), so the list above stays an honest record of progress.
  assert.deepEqual(Object.keys(NODE_BODIES).sort(), [...MOVED_SO_FAR].sort())
})
