import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSlackFlows, slackTriggerConfigOf } from '@/lib/slack/route-event'
import type { SlackTriggerInput } from '@/lib/slack/payload'

const mention: SlackTriggerInput = {
  kind: 'app_mention', text: '<@U0BOT9999> please deploy to prod', user: 'U0USER111',
  channel: 'C0CHAN111', ts: '1752300000.000100', team: 'T0AAA111',
}
const slash: SlackTriggerInput = {
  kind: 'slash_command', text: 'prod', user: 'U0USER111', channel: 'C0CHAN111', ts: '',
  team: 'T0AAA111', command: '/deploy', response_url: 'https://hooks.slack.com/commands/x',
}
const flow = (id: string, trigger: unknown) => ({ id, trigger })

test('slackTriggerConfigOf parses valid configs and rejects others', () => {
  assert.deepEqual(slackTriggerConfigOf({ type: 'slack', events: ['app_mention'], threadMemory: true }), {
    type: 'slack', events: ['app_mention'], threadMemory: true,
  })
  assert.equal(slackTriggerConfigOf({ type: 'webhook' }), null)
  assert.equal(slackTriggerConfigOf({ type: 'slack', events: [] }), null)
  assert.equal(slackTriggerConfigOf({ type: 'slack', events: ['nonsense'] }), null)
  assert.equal(slackTriggerConfigOf(null), null)
})

test('matches on event kind', () => {
  const flows = [
    flow('f1', { type: 'slack', events: ['app_mention'] }),
    flow('f2', { type: 'slack', events: ['message.im'] }),
    flow('f3', { type: 'webhook' }),
  ]
  assert.deepEqual(matchSlackFlows(mention, flows).map((m) => m.id), ['f1'])
})

test('slash commands match on command equality (leading slash and case ignored)', () => {
  const flows = [
    flow('f1', { type: 'slack', events: ['slash_command'], command: 'deploy' }),
    flow('f2', { type: 'slack', events: ['slash_command'], command: '/Deploy' }),
    flow('f3', { type: 'slack', events: ['slash_command'], command: '/status' }),
    flow('f4', { type: 'slack', events: ['app_mention'] }),
  ]
  assert.deepEqual(matchSlackFlows(slash, flows).map((m) => m.id), ['f1', 'f2'])
})

test('channel allowlist and keyword filter', () => {
  const flows = [
    flow('f1', { type: 'slack', events: ['app_mention'], channels: ['C0CHAN111'] }),
    flow('f2', { type: 'slack', events: ['app_mention'], channels: ['C0OTHER'] }),
    flow('f3', { type: 'slack', events: ['app_mention'], keyword: 'DEPLOY' }), // case-insensitive substring
    flow('f4', { type: 'slack', events: ['app_mention'], keyword: 'rollback' }),
  ]
  assert.deepEqual(matchSlackFlows(mention, flows).map((m) => m.id), ['f1', 'f3'])
})

test('workspace binding and user allowlists scope bot workflows', () => {
  const flows = [
    flow('workspace-user', { type: 'slack', events: ['app_mention'], bindingId: 'binding-1', users: ['U0USER111'] }),
    flow('wrong-workspace', { type: 'slack', events: ['app_mention'], bindingId: 'binding-2' }),
    flow('wrong-user', { type: 'slack', events: ['app_mention'], users: ['U0OTHER'] }),
  ]
  assert.deepEqual(matchSlackFlows(mention, flows, 'binding-1').map((match) => match.id), ['workspace-user'])
})

test('multiple matches all dispatch (each gets its own run)', () => {
  const flows = [
    flow('f1', { type: 'slack', events: ['app_mention'] }),
    flow('f2', { type: 'slack', events: ['app_mention', 'message.channels'] }),
  ]
  assert.equal(matchSlackFlows(mention, flows).length, 2)
})
