import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityGraphParts } from '@/lib/activity/index-activity'
import type { PersistedActivity } from '@/lib/activity/ledger'

const event: PersistedActivity = {
  id: 'ev-1', organizationId: 'org-1', ingestKind: 'webhook',
  source: 'slack', actorRef: 'U1', actorName: 'Sarah', action: 'posted_message',
  entityType: 'message', entityRef: 'C9:111.222', entityName: '#deals',
  participants: ['U2'], businessContext: { accountId: 'acme' },
  occurredAt: new Date('2026-07-10T00:00:00Z'), dedupeKey: 'k1',
}

test('projects actor→activity→entity with stable ids', () => {
  const { nodes, edges } = activityGraphParts(event)
  const ids = nodes.map((n) => n.id)
  assert.ok(ids.includes('activity:ev-1'))
  assert.ok(ids.includes('actor:slack:U1'))
  assert.ok(ids.includes('entity:slack:message:C9:111.222'))
  assert.deepEqual(
    edges.map((e) => `${e.from}-${e.rel}->${e.to}`).sort(),
    [
      'activity:ev-1-on->entity:slack:message:C9:111.222',
      'activity:ev-1-participant->actor:slack:U2',
      'activity:ev-1-relates_to->account:acme',
      'actor:slack:U1-performed->activity:ev-1',
    ].sort(),
  )
})

test('activity node text names actor, action, entity, source', () => {
  const { nodes } = activityGraphParts(event)
  const activity = nodes.find((n) => n.id === 'activity:ev-1')!
  assert.equal(activity.type, 'activity')
  for (const needle of ['Sarah', 'posted_message', '#deals', 'slack']) {
    assert.ok(activity.text.includes(needle), `text missing ${needle}`)
  }
})

test('preceded_by edge links state-history chains', () => {
  const { edges } = activityGraphParts(event, 'ev-0')
  assert.ok(edges.some((e) => e.from === 'activity:ev-1' && e.rel === 'preceded_by' && e.to === 'activity:ev-0'))
})

test('no relates_to edge when businessContext has no accountId', () => {
  const { edges } = activityGraphParts({ ...event, businessContext: {} })
  assert.ok(!edges.some((e) => e.rel === 'relates_to'))
})
