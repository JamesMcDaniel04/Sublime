/**
 * Merge — joining two branches back together.
 *
 * The one n8n core node with no Sublime workaround. `parallel` and `router`
 * fan work OUT; nothing fans it back IN, so a flow that queries two systems
 * and wants one combined result has to end in a code step.
 *
 * Four modes, matching what n8n's Merge actually gets used for:
 *
 *   append      — one list after the other
 *   byKey       — join on a field, with inner / left / outer
 *   byPosition  — zip, item 0 with item 0
 *   pickBranch  — take whichever branch produced something
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runMerge, MERGE_MODES } from '../merge'

const LEFT = [
  { id: 'a', name: 'Acme', tier: 'gold' },
  { id: 'b', name: 'Bolt', tier: 'silver' },
]
const RIGHT = [
  { id: 'a', mrr: 100 },
  { id: 'c', mrr: 50 },
]

// ── append ──────────────────────────────────────────────────────────────────

test('append concatenates both branches in order', () => {
  const out = runMerge({ mode: 'append' }, LEFT, RIGHT) as unknown[]
  assert.equal(out.length, 4)
  assert.deepEqual(out[0], LEFT[0])
  assert.deepEqual(out[2], RIGHT[0])
})

test('append treats a non-list branch as a single item', () => {
  const out = runMerge({ mode: 'append' }, { solo: true }, RIGHT) as unknown[]
  assert.equal(out.length, 3)
})

test('append with one empty branch returns the other unchanged', () => {
  assert.deepEqual(runMerge({ mode: 'append' }, [], RIGHT), RIGHT)
})

// ── byKey ───────────────────────────────────────────────────────────────────

test('an inner join keeps only matched rows and merges their fields', () => {
  const out = runMerge({ mode: 'byKey', leftKey: 'id', rightKey: 'id', join: 'inner' }, LEFT, RIGHT) as Record<string, unknown>[]
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'a')
  assert.equal(out[0].name, 'Acme')
  assert.equal(out[0].mrr, 100)
})

test('a left join keeps unmatched left rows', () => {
  const out = runMerge({ mode: 'byKey', leftKey: 'id', rightKey: 'id', join: 'left' }, LEFT, RIGHT) as Record<string, unknown>[]
  assert.equal(out.length, 2)
  const bolt = out.find((row) => row.id === 'b')
  assert.equal(bolt?.name, 'Bolt')
  assert.equal(bolt?.mrr, undefined, 'an unmatched left row gets no right fields')
})

test('an outer join keeps unmatched rows from both sides', () => {
  const out = runMerge({ mode: 'byKey', leftKey: 'id', rightKey: 'id', join: 'outer' }, LEFT, RIGHT) as Record<string, unknown>[]
  assert.equal(out.length, 3)
  assert.ok(out.some((row) => row.id === 'c'), 'the unmatched right row should survive')
})

test('the right key may differ from the left key', () => {
  const right = [{ account_id: 'a', mrr: 100 }]
  const out = runMerge({ mode: 'byKey', leftKey: 'id', rightKey: 'account_id', join: 'inner' }, LEFT, right) as Record<string, unknown>[]
  assert.equal(out.length, 1)
  assert.equal(out[0].mrr, 100)
})

// Left wins on conflict: the left branch is the one the author put first, and
// silently preferring the right would make the result depend on edge order.
test('on a field collision the left value wins', () => {
  const out = runMerge(
    { mode: 'byKey', leftKey: 'id', rightKey: 'id', join: 'inner' },
    [{ id: 'a', tier: 'gold' }],
    [{ id: 'a', tier: 'bronze' }],
  ) as Record<string, unknown>[]
  assert.equal(out[0].tier, 'gold')
})

// A duplicate key is a real shape in CRM exports; it must not silently drop.
test('duplicate keys on the right produce a row per match', () => {
  const out = runMerge(
    { mode: 'byKey', leftKey: 'id', rightKey: 'id', join: 'inner' },
    [{ id: 'a', name: 'Acme' }],
    [{ id: 'a', contact: 'ana' }, { id: 'a', contact: 'bo' }],
  ) as unknown[]
  assert.equal(out.length, 2)
})

test('a missing key on a row excludes it from an inner join rather than matching null', () => {
  const out = runMerge(
    { mode: 'byKey', leftKey: 'id', rightKey: 'id', join: 'inner' },
    [{ name: 'no id here' }],
    [{ name: 'also none' }],
  ) as unknown[]
  assert.equal(out.length, 0, 'two undefined keys must not be treated as equal')
})

test('byKey without a key configured is an error, not an empty result', () => {
  const result = runMerge({ mode: 'byKey' }, LEFT, RIGHT)
  assert.ok(result && typeof result === 'object' && 'error' in (result as object))
})

// ── byPosition ──────────────────────────────────────────────────────────────

test('byPosition zips items pairwise', () => {
  const out = runMerge({ mode: 'byPosition' }, LEFT, RIGHT) as Record<string, unknown>[]
  assert.equal(out.length, 2)
  assert.equal(out[0].name, 'Acme')
  assert.equal(out[0].mrr, 100)
})

test('byPosition stops at the shorter branch', () => {
  const out = runMerge({ mode: 'byPosition' }, LEFT, [{ mrr: 1 }]) as unknown[]
  assert.equal(out.length, 1)
})

// ── pickBranch ──────────────────────────────────────────────────────────────

test('pickBranch returns whichever branch produced something', () => {
  assert.deepEqual(runMerge({ mode: 'pickBranch' }, [], RIGHT), RIGHT)
  assert.deepEqual(runMerge({ mode: 'pickBranch' }, LEFT, []), LEFT)
})

test('pickBranch prefers the left when both ran', () => {
  assert.deepEqual(runMerge({ mode: 'pickBranch' }, LEFT, RIGHT), LEFT)
})

// ── shape ───────────────────────────────────────────────────────────────────

test('MERGE_MODES names every mode the node offers', () => {
  assert.deepEqual([...MERGE_MODES].sort(), ['append', 'byKey', 'byPosition', 'pickBranch'])
})

test('an unknown mode is an error rather than a silent append', () => {
  const result = runMerge({ mode: 'nonsense' as never }, LEFT, RIGHT)
  assert.ok(result && typeof result === 'object' && 'error' in (result as object))
})
