/**
 * The node-body registry's structural guarantees.
 *
 * The load-bearing one: ALL_TYPES must match the FlowNode union exactly, so a
 * new node type added to graph.ts fails here until it has a param surface —
 * rather than rendering an empty config panel in production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NODE_BODIES } from '../registry'

// Mirrors the discriminated union assembled at graph.ts:479. Listed explicitly
// rather than derived from NODE_BODIES' own keys: a test that reads its
// expectations off the thing under test proves nothing.
const ALL_TYPES = [
  'trigger', 'agent', 'code', 'condition', 'loop', 'parallel', 'stop', 'tool', 'http',
  'transform', 'filter', 'switch', 'variable', 'data', 'humanReview',
  'respondWebhook', 'wait', 'repeatUntil', 'input', 'output', 'subflow',
  'router', 'errorShield', 'merge', 'vector',
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

/**
 * Filter and Condition used to share one module outright. That kept the clause
 * editor in one place — the right instinct — but it also meant Filter rendered
 * Condition's branching framing, and neither could expose `splitItems`, which
 * on Filter is the difference between filtering a list and gating the flow.
 *
 * Filter now has its own module. The original concern still holds, so the
 * invariant moves rather than disappears: ONE clause editor, composed.
 */
test('filter has its own body module', () => {
  assert.notEqual(NODE_BODIES.condition, NODE_BODIES.filter)
})

test('filter composes the clause editor rather than copying it', () => {
  const source = readFileSync(new URL('../filter-body.tsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ ConditionBody \}/, 'filter must reuse ConditionBody, not reimplement clauses')
  // A second clause-row implementation is the thing being guarded against.
  assert.doesNotMatch(source, /CONDITION_OPS/, 'filter looks like it is rebuilding the clause editor')
})
