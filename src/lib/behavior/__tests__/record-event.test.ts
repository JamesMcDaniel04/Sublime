import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordToolCallEvents,
  recordUserEvent,
  USER_EVENT_KINDS,
  type UserEventCreateData,
} from '@/lib/behavior/record-event'

test('tool_call events carry the outcome of the run that made them', async () => {
  const rows: UserEventCreateData[] = []
  await recordToolCallEvents(
    {
      organizationId: 'org-1',
      userId: 'u-1',
      executionId: 'exec-1',
      touched: new Map([['slack', new Set(['post_message'])]]),
      succeeded: false,
    },
    { record: async (input) => { rows.push(input as UserEventCreateData) } },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].resourceId, 'slack')
  assert.deepEqual(rows[0].context, {
    provider: 'slack',
    toolNames: ['post_message'],
    executionId: 'exec-1',
    succeeded: false,
  })
})

test('every provider a failed run touched is marked failed', async () => {
  const rows: UserEventCreateData[] = []
  await recordToolCallEvents(
    {
      organizationId: 'org-1',
      userId: 'u-1',
      executionId: 'exec-1',
      touched: new Map([
        ['slack', new Set(['post_message'])],
        ['salesforce', new Set(['update_opportunity'])],
      ]),
      succeeded: false,
    },
    { record: async (input) => { rows.push(input as UserEventCreateData) } },
  )
  assert.deepEqual(
    rows.map((row) => (row.context as { succeeded: boolean }).succeeded),
    [false, false],
  )
})

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
    'assistant_prompt', 'connection_added', 'connection_removed', 'copilot_prompt',
    'flow_created', 'flow_edited', 'flow_published', 'flow_run_feedback', 'flow_run_manual', 'flow_run_outcome',
    'goal_abandoned', 'goal_achieved', 'goal_contribution_linked', 'goal_created',
    'goal_datapoints_imported', 'goal_estimate_edited', 'goal_off_track',
    'suggestion_accepted', 'suggestion_dismissed', 'template_used', 'tool_call',
  ])
})
