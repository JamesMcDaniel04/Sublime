/**
 * Declarative node parameters — the visibility rule.
 *
 * Node panels are hand-written JSX today, so whether a field appears is an
 * `&&` someone has to remember on every schema change. Three fields shipped
 * this session that the executor reads and no panel rendered: `data.count`
 * (Limit silently pinned to 10), `data.field` (splitOut), and `splitItems`
 * (which meant the Filter node could not filter).
 *
 * n8n avoids that class entirely by making visibility DATA — `displayOptions`
 * on each property, evaluated against the node's current values. This is that
 * rule, and the semantics are deliberately n8n's:
 *
 *   several keys in one `showWhen`  → ALL must match (AND)
 *   several values under one key    → ANY matches (OR)
 *   no `showWhen`                   → always visible
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleParams, type ParamSpec } from '../node-params'

const SPECS: ParamSpec[] = [
  { key: 'input', label: 'Input', control: 'text' },
  { key: 'count', label: 'Items to keep', control: 'number', showWhen: { op: ['limit'] } },
  { key: 'separator', label: 'Join with', control: 'text', showWhen: { op: ['join', 'concat'] } },
  { key: 'depth', label: 'Depth', control: 'number', showWhen: { op: ['limit'], mode: ['deep'] } },
]

const keysFor = (data: Record<string, unknown>) => visibleParams(SPECS, data).map((spec) => spec.key)

test('a param with no condition is always visible', () => {
  assert.ok(keysFor({}).includes('input'))
  assert.ok(keysFor({ op: 'limit' }).includes('input'))
})

test('a param appears only for the value it is gated on', () => {
  assert.ok(keysFor({ op: 'limit' }).includes('count'))
  assert.ok(!keysFor({ op: 'join' }).includes('count'))
})

// Several values under one key is an OR — n8n's semantics.
test('any listed value satisfies the condition', () => {
  assert.ok(keysFor({ op: 'join' }).includes('separator'))
  assert.ok(keysFor({ op: 'concat' }).includes('separator'))
  assert.ok(!keysFor({ op: 'limit' }).includes('separator'))
})

// Several keys in one showWhen is an AND.
test('every condition key must match, not just one', () => {
  assert.ok(!keysFor({ op: 'limit' }).includes('depth'), 'matched on op alone')
  assert.ok(!keysFor({ mode: 'deep' }).includes('depth'), 'matched on mode alone')
  assert.ok(keysFor({ op: 'limit', mode: 'deep' }).includes('depth'))
})

// The safe direction: an unset value hides a conditional field rather than
// showing one that does not apply.
test('an absent value hides a conditional param', () => {
  assert.ok(!keysFor({}).includes('count'))
})

test('order is preserved so the panel is stable', () => {
  assert.deepEqual(keysFor({ op: 'limit', mode: 'deep' }), ['input', 'count', 'depth'])
})

// Values arrive from a Json column and are not guaranteed to be strings.
test('a non-string value is compared by its string form, not crashed on', () => {
  const specs: ParamSpec[] = [{ key: 'x', label: 'X', control: 'text', showWhen: { count: ['3'] } }]
  assert.equal(visibleParams(specs, { count: 3 }).length, 1)
})

test('a null or undefined node value never matches', () => {
  const specs: ParamSpec[] = [{ key: 'x', label: 'X', control: 'text', showWhen: { op: ['limit'] } }]
  assert.equal(visibleParams(specs, { op: null }).length, 0)
  assert.equal(visibleParams(specs, { op: undefined }).length, 0)
})
