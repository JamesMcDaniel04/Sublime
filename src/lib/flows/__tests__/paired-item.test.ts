/**
 * Paired-item lineage: `{{<Step>.item.<path>}}`.
 *
 * The gap this closes is the one behind n8n expressions like
 * `$('Resolve Slack Channel').item.json.slackChannelId` — "the item THAT step
 * produced which corresponds to the item I am currently processing". Without
 * it, a loop body can read an earlier step's whole output but cannot line it
 * up with the item in hand, which is the single most common thing a
 * per-item flow needs to do.
 *
 * The rule that makes this safe: a pairing is either KNOWN or absent. Where
 * correspondence cannot be established, this resolves to undefined rather than
 * guessing — returning the wrong item silently is far worse than returning
 * nothing, because the flow keeps running with data from another record.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairedItemFor } from '../paired-item'

// ── positional pairing ──────────────────────────────────────────────────────
//
// A step that ran BEFORE the loop and produced a parallel array: item i of its
// output corresponds to iteration i.

const parallel = { output: ['a', 'b', 'c'] }

test('an array output pairs by position with the current iteration', () => {
  assert.equal(pairedItemFor(parallel, { index: 0, count: 3 }), 'a')
  assert.equal(pairedItemFor(parallel, { index: 2, count: 3 }), 'c')
})

// The dangerous case. Arrays of different lengths have no defensible
// correspondence, so pairing must fail rather than return a neighbouring
// record — a flow that emails the wrong customer is worse than one that
// visibly has no value.
test('a length mismatch yields nothing rather than a wrong item', () => {
  assert.equal(pairedItemFor({ output: ['a', 'b'] }, { index: 2, count: 3 }), undefined)
  assert.equal(pairedItemFor({ output: ['a', 'b', 'c', 'd'] }, { index: 0, count: 3 }), undefined)
})

test('an index outside the array yields nothing', () => {
  assert.equal(pairedItemFor(parallel, { index: 5, count: 3 }), undefined)
  assert.equal(pairedItemFor(parallel, { index: -1, count: 3 }), undefined)
})

// ── iteration-scoped pairing ────────────────────────────────────────────────
//
// A step INSIDE the loop body already produced one output per iteration, so
// the correspondence is exact rather than inferred.

test('an iteration-scoped output pairs exactly', () => {
  const scoped = { outputByIteration: { 0: 'first', 1: 'second' } }
  assert.equal(pairedItemFor(scoped, { index: 1, count: 2 }), 'second')
})

// Exact lineage beats positional inference when both could apply.
test('exact lineage wins over positional inference', () => {
  const both = { output: ['wrong', 'also wrong'], outputByIteration: { 0: 'right' } }
  assert.equal(pairedItemFor(both, { index: 0, count: 2 }), 'right')
})

test('a missing iteration yields nothing rather than falling back to position', () => {
  const scoped = { outputByIteration: { 0: 'first' } }
  assert.equal(
    pairedItemFor({ ...scoped, output: ['a', 'b'] }, { index: 1, count: 2 }),
    undefined,
    'a step that did not run this iteration was paired positionally anyway',
  )
})

// ── outside a loop ──────────────────────────────────────────────────────────

// With no iteration there is no "current item" to pair with. A single output
// is the whole answer.
test('outside a loop a non-array output is itself', () => {
  assert.equal(pairedItemFor({ output: 'single' }, undefined), 'single')
})

// ...but an ARRAY outside a loop has no single corresponding item, and
// silently taking the first would be a guess.
test('outside a loop an array output has no single item', () => {
  assert.equal(pairedItemFor(parallel, undefined), undefined)
})

// A one-item array in a one-iteration loop is unambiguous.
test('a single-item array pairs with a single iteration', () => {
  assert.equal(pairedItemFor({ output: ['only'] }, { index: 0, count: 1 }), 'only')
})

// ── absent and malformed ────────────────────────────────────────────────────

test('a step that never ran yields nothing', () => {
  assert.equal(pairedItemFor(undefined, { index: 0, count: 1 }), undefined)
  assert.equal(pairedItemFor(null, { index: 0, count: 1 }), undefined)
})

test('a step whose output is absent yields nothing', () => {
  assert.equal(pairedItemFor({}, { index: 0, count: 1 }), undefined)
})

// null is a legitimate value a step can produce, and must be returned rather
// than treated as "no pairing".
test('a null item is a real value, not a missing pairing', () => {
  assert.equal(pairedItemFor({ output: [null, 'b'] }, { index: 0, count: 2 }), null)
})

test('an object output outside a loop is itself', () => {
  const value = { id: 1 }
  assert.deepEqual(pairedItemFor({ output: value }, undefined), value)
})

// A non-array output inside a loop is the same for every iteration — a lookup
// table or a config blob fetched once. That IS the corresponding item.
test('a non-array output inside a loop is shared by every iteration', () => {
  assert.deepEqual(pairedItemFor({ output: { rate: 1.2 } }, { index: 3, count: 9 }), { rate: 1.2 })
})
