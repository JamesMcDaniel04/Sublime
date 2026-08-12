import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickRecentFlows, RECENT_FLOWS_LIMIT } from '../recent'

const flow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Flow ${id}`,
  status: 'active',
  updatedAt: '2026-08-11T00:00:00.000Z',
  ...overrides,
})

test('caps at three and preserves the API order', () => {
  const flows = [flow('a'), flow('b'), flow('c'), flow('d')]
  const picked = pickRecentFlows(flows)
  assert.equal(RECENT_FLOWS_LIMIT, 3)
  assert.deepEqual(picked.map((f) => f.id), ['a', 'b', 'c'])
})

test('excludes suggested drafts but keeps suggested flows the user activated', () => {
  const flows = [
    flow('suggested-draft', { suggested: true, status: 'draft' }),
    flow('suggested-active', { suggested: true, status: 'active' }),
    flow('plain-draft', { status: 'draft' }),
  ]
  const picked = pickRecentFlows(flows)
  assert.deepEqual(picked.map((f) => f.id), ['suggested-active', 'plain-draft'])
})

test('includes disabled and draft (non-suggested) flows', () => {
  const flows = [flow('off', { status: 'disabled' }), flow('wip', { status: 'draft' })]
  assert.deepEqual(pickRecentFlows(flows).map((f) => f.id), ['off', 'wip'])
})

test('returns [] for empty, undefined, null, and non-array input', () => {
  assert.deepEqual(pickRecentFlows([]), [])
  assert.deepEqual(pickRecentFlows(undefined), [])
  assert.deepEqual(pickRecentFlows(null), [])
  assert.deepEqual(pickRecentFlows('nope' as never), [])
})
