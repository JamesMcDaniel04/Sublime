/**
 * Flow static data — state that survives between runs.
 *
 * n8n gives every workflow a persistent key-value store
 * (`$getWorkflowStaticData`). It is how polling triggers remember cursors and
 * how flows dedupe across executions. Sublime had one special case of it —
 * the poll trigger's private cursor — and nothing general, so "only act on
 * rows I have not seen before" was unexpressible.
 *
 * The pure half is the dedupe decision: given what a flow has already seen,
 * which of these items are new? Kept separate from the store so the rule is
 * testable without a database, and so the store can be swapped without
 * touching the semantics.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionUnseen, identityOf, boundSeen, MAX_SEEN_KEYS } from '../static-data'

test('identity uses the named field when present', () => {
  assert.equal(identityOf({ id: 'x1', name: 'a' }, 'id'), 'x1')
})

test('identity falls back to a content hash when the field is absent', () => {
  const a = identityOf({ name: 'a' }, 'id')
  const b = identityOf({ name: 'a' }, 'id')
  const c = identityOf({ name: 'b' }, 'id')
  assert.equal(a, b, 'the same content must hash the same')
  assert.notEqual(a, c)
})

// Key order out of a JSON column is not stable, so a content hash that depends
// on it would report the same row as new on every run.
test('a content hash ignores key order', () => {
  assert.equal(identityOf({ a: 1, b: 2 }, 'id'), identityOf({ b: 2, a: 1 }, 'id'))
})

test('a primitive item hashes by its value', () => {
  assert.equal(identityOf('hello', 'id'), identityOf('hello', 'id'))
  assert.notEqual(identityOf('hello', 'id'), identityOf('world', 'id'))
})

// ── partitioning ────────────────────────────────────────────────────────────

test('every item is new when nothing has been seen', () => {
  const { fresh, identities } = partitionUnseen([{ id: 'a' }, { id: 'b' }], 'id', [])
  assert.equal(fresh.length, 2)
  assert.deepEqual(identities.sort(), ['a', 'b'])
})

test('items already seen are dropped', () => {
  const { fresh } = partitionUnseen([{ id: 'a' }, { id: 'b' }], 'id', ['a'])
  assert.deepEqual(fresh, [{ id: 'b' }])
})

// A batch containing the same id twice must yield it once, or the first run
// records it and the second copy slips through as "new" next time.
test('a duplicate within one batch is emitted once', () => {
  const { fresh, identities } = partitionUnseen([{ id: 'a' }, { id: 'a' }], 'id', [])
  assert.equal(fresh.length, 1)
  assert.equal(identities.length, 1)
})

test('order is preserved so downstream steps see the source order', () => {
  const { fresh } = partitionUnseen([{ id: 'c' }, { id: 'a' }, { id: 'b' }], 'id', ['a'])
  assert.deepEqual(fresh.map((item) => (item as { id: string }).id), ['c', 'b'])
})

test('nothing new returns an empty list rather than the input', () => {
  const { fresh } = partitionUnseen([{ id: 'a' }], 'id', ['a'])
  assert.deepEqual(fresh, [])
})

// ── bounding ────────────────────────────────────────────────────────────────
//
// The seen-set is stored on the flow, so an unbounded one grows forever and
// eventually makes every run read a megabyte of ids to answer one question.

test('the seen set is capped, keeping the most recent', () => {
  const many = Array.from({ length: MAX_SEEN_KEYS + 50 }, (_, i) => `k${i}`)
  const bounded = boundSeen(many)
  assert.equal(bounded.length, MAX_SEEN_KEYS)
  // The most recent survive: dropping new ids would re-emit rows just seen.
  assert.equal(bounded.at(-1), `k${many.length - 1}`)
})

test('a set under the cap is untouched', () => {
  assert.deepEqual(boundSeen(['a', 'b']), ['a', 'b'])
})

test('bounding removes duplicates while keeping the last occurrence', () => {
  assert.deepEqual(boundSeen(['a', 'b', 'a']), ['b', 'a'])
})
