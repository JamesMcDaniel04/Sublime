import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordUserEvent, USER_EVENT_KINDS, type UserEventCreateData } from '@/lib/behavior/record-event'

test('writes the event row with defaults applied', async () => {
  const rows: UserEventCreateData[] = []
  await recordUserEvent(
    { organizationId: 'org-1', userId: 'u-1', kind: 'agent_run_manual', resourceType: 'agent', resourceId: 'a-1', context: { name: 'Pipeline review' } },
    { create: async (data) => { rows.push(data) } },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].organizationId, 'org-1')
  assert.equal(rows[0].userId, 'u-1')
  assert.equal(rows[0].kind, 'agent_run_manual')
  assert.equal(rows[0].resourceType, 'agent')
  assert.equal(rows[0].resourceId, 'a-1')
  assert.deepEqual(rows[0].context, { name: 'Pipeline review' })
})

test('optional fields default to null / empty context', async () => {
  const rows: UserEventCreateData[] = []
  await recordUserEvent(
    { organizationId: 'org-1', userId: 'u-1', kind: 'assistant_prompt' },
    { create: async (data) => { rows.push(data) } },
  )
  assert.equal(rows[0].resourceType, null)
  assert.equal(rows[0].resourceId, null)
  assert.deepEqual(rows[0].context, {})
})

test('NEVER throws when the write fails', async () => {
  await assert.doesNotReject(
    recordUserEvent(
      { organizationId: 'org-1', userId: 'u-1', kind: 'flow_created' },
      { create: async () => { throw new Error('db down') } },
    ),
  )
})

test('kind list is the bounded spec set', () => {
  assert.deepEqual([...USER_EVENT_KINDS].sort(), [
    'agent_created', 'agent_edited', 'agent_run_manual',
    'assistant_prompt', 'connection_added', 'copilot_prompt',
    'flow_created', 'flow_edited', 'flow_published', 'flow_run_manual',
    'suggestion_accepted', 'suggestion_dismissed', 'template_used', 'tool_call',
  ])
})
