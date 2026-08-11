import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fairDispatchOrder, flowRunClaimDecision } from '../flow-outbox'

test('outbox recovery round-robins organizations instead of draining a noisy tenant first', () => {
  const at = new Date('2026-08-11T00:00:00Z')
  const rows = [
    ...['a1', 'a2', 'a3', 'a4'].map((id) => ({ id, organizationId: 'org-a', availableAt: at })),
    { id: 'b1', organizationId: 'org-b', availableAt: at },
    { id: 'c1', organizationId: 'org-c', availableAt: at },
  ]
  assert.deepEqual(fairDispatchOrder(rows, 5).map((row) => row.id), ['a1', 'b1', 'c1', 'a2', 'a3'])
})

test('a worker crash is recoverable only after its durable lease expires', () => {
  const now = new Date('2026-08-11T12:00:00Z')
  assert.equal(flowRunClaimDecision('running', new Date(now.getTime() - 1), now), 'claim')
  assert.equal(flowRunClaimDecision('claimed', new Date(now.getTime() + 60_000), now), 'wait')
  assert.equal(flowRunClaimDecision('succeeded', null, now), 'terminal')
})
