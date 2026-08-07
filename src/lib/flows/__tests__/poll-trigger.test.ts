import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffPollResult, pollConfigFrom, pollIsDue, pollItemsFrom, POLL_MAX_NEW_ITEMS_PER_TICK } from '../poll-trigger'

const NOW = new Date('2026-08-07T12:00:00Z')

test('pollConfigFrom validates and defaults', () => {
  assert.equal(pollConfigFrom({ type: 'poll' }), null)
  assert.equal(pollConfigFrom({ type: 'poll', source: { connectionId: 'nango:sheets' } }), null)
  const config = pollConfigFrom({ type: 'poll', source: { connectionId: 'nango:sheets', toolName: 'sheets_get_values', args: '{"range":"A:C"}' } })
  assert.equal(config?.intervalMinutes, 15)
  const fast = pollConfigFrom({ type: 'poll', intervalMinutes: 1, source: { connectionId: 'nango:sheets', toolName: 'x' } })
  assert.equal(fast?.intervalMinutes, 5, 'interval clamps to the minimum')
})

test('pollIsDue respects the interval', () => {
  assert.equal(pollIsDue({}, 15, NOW), true)
  assert.equal(pollIsDue({ lastPollAt: '2026-08-07T11:50:00Z' }, 15, NOW), false)
  assert.equal(pollIsDue({ lastPollAt: '2026-08-07T11:40:00Z' }, 15, NOW), true)
})

test('pollItemsFrom finds lists by path, shape, or common keys', () => {
  assert.deepEqual(pollItemsFrom([1, 2]), [1, 2])
  assert.deepEqual(pollItemsFrom({ records: [3] }), [3])
  assert.deepEqual(pollItemsFrom({ body: { rows: [4] } }, 'body'), [4])
  assert.deepEqual(pollItemsFrom({ nothing: true }), [])
})

test('first poll baselines without dispatching; later polls emit only new items', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  const baseline = diffPollResult({ items: rows }, {}, {}, NOW)
  assert.deepEqual(baseline.newItems, [])
  assert.equal(baseline.nextState.seen?.length, 2)

  const next = diffPollResult({ items: [...rows, { id: 'c' }] }, baseline.nextState, {}, NOW)
  assert.deepEqual(next.newItems, [{ id: 'c' }])
  assert.ok(next.nextState.seen?.includes('id:c'))
})

test('items without ids fall back to content hashing; per-tick cap holds', () => {
  const baseline = diffPollResult([{ v: 1 }], {}, { idPath: 'missing' }, NOW)
  const flood = Array.from({ length: 50 }, (_unused, index) => ({ v: index + 100 }))
  const next = diffPollResult(flood, baseline.nextState, { idPath: 'missing' }, NOW)
  assert.equal(next.newItems.length, POLL_MAX_NEW_ITEMS_PER_TICK)
})
