import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeCursor, decodeCursor, mergeTracePages } from '../merge'

const row = (kind: 'agent' | 'flow', id: string, startedAt: string) => ({ kind, id, startedAt })

test('merges newest-first with id tiebreak', () => {
  const { rows } = mergeTracePages(
    [row('agent', 'a2', '2026-08-14T00:00:02Z'), row('agent', 'a1', '2026-08-14T00:00:01Z')],
    [row('flow', 'f9', '2026-08-14T00:00:02Z'), row('flow', 'f1', '2026-08-14T00:00:00Z')],
    10,
  )
  // Equal timestamps: id desc — 'f9' > 'a2'.
  assert.deepEqual(rows.map((r) => r.id), ['f9', 'a2', 'a1', 'f1'])
})

test('page cap produces per-source high-water marks', () => {
  const { rows, next } = mergeTracePages(
    [row('agent', 'a3', '2026-08-14T00:00:03Z'), row('agent', 'a1', '2026-08-14T00:00:01Z')],
    [row('flow', 'f2', '2026-08-14T00:00:02Z'), row('flow', 'f0', '2026-08-14T00:00:00Z')],
    2,
  )
  assert.deepEqual(rows.map((r) => r.id), ['a3', 'f2'])
  assert.deepEqual(next, { a: ['2026-08-14T00:00:03Z', 'a3'], f: ['2026-08-14T00:00:02Z', 'f2'] })
})

test('one source exhausted: everything fits → no next page', () => {
  const { rows, next } = mergeTracePages([], [row('flow', 'f1', '2026-08-14T00:00:00Z')], 5)
  assert.deepEqual(rows.map((r) => r.id), ['f1'])
  assert.equal(next, null)
})

test('page cap consuming only one source leaves the other mark null', () => {
  const { rows, next } = mergeTracePages(
    [row('agent', 'a3', '2026-08-14T00:00:03Z'), row('agent', 'a2', '2026-08-14T00:00:02Z')],
    [row('flow', 'f0', '2026-08-14T00:00:00Z')],
    2,
  )
  assert.deepEqual(rows.map((r) => r.id), ['a3', 'a2'])
  assert.deepEqual(next, { a: ['2026-08-14T00:00:02Z', 'a2'], f: null })
})

test('cursor roundtrip; malformed decodes to null', () => {
  const cursor = { a: ['2026-08-14T00:00:03Z', 'a3'] as [string, string], f: null }
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor)
  assert.equal(decodeCursor('%%%not-base64%%%'), null)
  assert.equal(decodeCursor(null), null)
})
