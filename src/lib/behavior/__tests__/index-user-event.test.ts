import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userEventGraphParts, type PersistedUserEvent } from '@/lib/behavior/index-user-event'

const base: PersistedUserEvent = {
  id: 'ue-1', organizationId: 'org-1', userId: 'u-1', kind: 'agent_run_manual',
  resourceType: 'agent', resourceId: 'a-1',
  context: { name: 'Pipeline review' }, occurredAt: new Date('2026-07-10T09:00:00Z'),
}

test('projects private actor→activity, edge to existing agent node, no agent stub', () => {
  const { nodes, edges } = userEventGraphParts(base)
  const activity = nodes.find((n) => n.id === 'uevent:ue-1')
  assert.ok(activity)
  assert.equal(activity.type, 'activity')
  assert.equal(activity.visibility, 'private')
  assert.equal(activity.ownerUserId, 'u-1')
  assert.ok(activity.text.includes('agent_run_manual'))
  assert.ok(activity.text.includes('Pipeline review'))
  const actor = nodes.find((n) => n.id === 'actor:sublime:u-1')
  assert.ok(actor)
  assert.equal(actor.visibility, 'private')
  // Agents are already indexed by indexAgent — emitting a stub here would
  // clobber the rich agent node text on upsert. Edge only.
  assert.ok(!nodes.some((n) => n.id === 'agent:a-1'))
  assert.deepEqual(
    edges.map((e) => `${e.from}-${e.rel}->${e.to}`).sort(),
    ['actor:sublime:u-1-performed->uevent:ue-1', 'uevent:ue-1-on->agent:a-1'].sort(),
  )
})

test('flow resource gets a stub entity node (no other indexer owns flow nodes)', () => {
  const { nodes, edges } = userEventGraphParts({ ...base, id: 'ue-2', kind: 'flow_edited', resourceType: 'flow', resourceId: 'f-1', context: { name: 'Follow-ups' } })
  const stub = nodes.find((n) => n.id === 'flow:f-1')
  assert.ok(stub)
  assert.equal(stub.type, 'entity')
  assert.ok(stub.text.includes('Follow-ups'))
  assert.ok(edges.some((e) => e.from === 'uevent:ue-2' && e.rel === 'on' && e.to === 'flow:f-1'))
})

test('preceded_by chains to the prior event of the SAME user', () => {
  const { edges } = userEventGraphParts({ ...base, id: 'ue-3' }, 'ue-1')
  assert.ok(edges.some((e) => e.from === 'uevent:ue-3' && e.rel === 'preceded_by' && e.to === 'uevent:ue-1'))
})

test('resource-less events (assistant_prompt) project actor→activity only', () => {
  const { nodes, edges } = userEventGraphParts({ ...base, id: 'ue-4', kind: 'assistant_prompt', resourceType: null, resourceId: null, context: {} })
  assert.equal(nodes.length, 2)
  assert.deepEqual(edges.map((e) => e.rel), ['performed'])
})
