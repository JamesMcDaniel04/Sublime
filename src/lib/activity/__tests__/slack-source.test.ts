import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slackActivityFromInput } from '@/lib/activity/sources/slack'
import { getActivitySource } from '@/lib/activity/registry'

const input = {
  kind: 'message.channels' as const,
  text: 'shipping the acme proposal today',
  user: 'U1', channel: 'C9', ts: '1752300000.000100', team: 'T1',
}

test('normalizes a channel message: actor, action, entity, dedupe key, timestamp', () => {
  const activity = slackActivityFromInput(input)!
  assert.equal(activity.source, 'slack')
  assert.equal(activity.actorRef, 'U1')
  assert.equal(activity.action, 'posted_message')
  assert.equal(activity.entityType, 'message')
  assert.equal(activity.entityRef, 'C9:1752300000.000100')
  assert.equal(activity.dedupeKey, 'slack:C9:1752300000.000100')
  assert.equal(activity.occurredAt.getTime(), 1752300000000)
  assert.equal((activity.businessContext as { channel: string }).channel, 'C9')
})

test('thread replies carry the thread as context and replied_in_thread action', () => {
  const activity = slackActivityFromInput({ ...input, thread_ts: '1752290000.000001' })!
  assert.equal(activity.action, 'replied_in_thread')
  assert.equal((activity.businessContext as { thread_ts: string }).thread_ts, '1752290000.000001')
})

test('slash commands and empty-ts inputs produce no activity', () => {
  assert.equal(slackActivityFromInput({ ...input, kind: 'slash_command', ts: '' }), null)
})

test('registry resolves the slack source with backfill + webhook capabilities', () => {
  const source = getActivitySource('slack')!
  assert.equal(source.source, 'slack')
  assert.equal(source.capabilities.backfill, true)
  assert.equal(source.capabilities.webhooks, true)
  assert.equal(getActivitySource('nope'), null)
})
