import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slackOriginOf, resolveSlackReplyText, shouldSuppressSuccessReply } from '@/lib/slack/reply'

test('slackOriginOf reads the trigger.slack block and rejects everything else', () => {
  const origin = slackOriginOf({ type: 'slack', slack: { bindingId: 'b1', channel: 'C1', thread_ts: '1.0', kind: 'app_mention' } })
  assert.deepEqual(origin, { bindingId: 'b1', channel: 'C1', thread_ts: '1.0', kind: 'app_mention' })
  assert.equal(slackOriginOf({ type: 'webhook' }), null)
  assert.equal(slackOriginOf({ type: 'slack' }), null) // missing origin block
  assert.equal(slackOriginOf({ type: 'slack', slack: { bindingId: 'b1' } }), null) // missing channel
  assert.equal(slackOriginOf(null), null)
})

test('resolveSlackReplyText: succeeded → formatted output; failed → notice; waiting → question', () => {
  assert.equal(resolveSlackReplyText({ status: 'succeeded', output: 'All done' }), 'All done')
  assert.match(resolveSlackReplyText({ status: 'failed', error: 'HTTP 500: boom' })!, /failed.*HTTP 500: boom/s)
  assert.match(resolveSlackReplyText({ status: 'failed', error: null })!, /failed/)
  assert.equal(resolveSlackReplyText({ status: 'waiting', question: 'Which environment?' }), 'Which environment?')
  assert.match(resolveSlackReplyText({ status: 'waiting' })!, /waiting for your reply/)
})

const nodesById = new Map<string, { type: string; data?: Record<string, unknown> }>([
  ['t1', { type: 'tool', data: { connectionId: 'native:slack', toolName: 'post_message', args: '{"channel":"C0CHAN111","text":"hi"}' } }],
  ['t2', { type: 'tool', data: { connectionId: 'native:granola', toolName: 'get_meetings', args: '{}' } }],
  ['a1', { type: 'agent', data: {} }],
])

test('suppression: a succeeded slack-plane step to the same channel suppresses', () => {
  const steps = [{ nodeId: 't1', status: 'succeeded', input: { connectionId: 'native:slack', toolName: 'post_message', args: '{"channel":"C0CHAN111","text":"hi"}' } }]
  assert.equal(shouldSuppressSuccessReply({ steps, nodesById, channel: 'C0CHAN111' }), true)
})

test('no suppression: different channel, non-slack plane, failed step, or agent step', () => {
  assert.equal(shouldSuppressSuccessReply({
    steps: [{ nodeId: 't1', status: 'succeeded', input: { args: '{"channel":"C0OTHER","text":"hi"}' } }],
    nodesById, channel: 'C0CHAN111',
  }), false)
  assert.equal(shouldSuppressSuccessReply({
    steps: [{ nodeId: 't2', status: 'succeeded', input: { args: '{"channel":"C0CHAN111"}' } }],
    nodesById, channel: 'C0CHAN111',
  }), false)
  assert.equal(shouldSuppressSuccessReply({
    steps: [{ nodeId: 't1', status: 'failed', input: { args: '{"channel":"C0CHAN111"}' } }],
    nodesById, channel: 'C0CHAN111',
  }), false)
  assert.equal(shouldSuppressSuccessReply({ steps: [{ nodeId: 'a1', status: 'succeeded' }], nodesById, channel: 'C0CHAN111' }), false)
})
