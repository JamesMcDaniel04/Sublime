import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSlackEventPayload, normalizeSlackCommandPayload, SLACK_EVENT_KINDS } from '@/lib/slack/payload'

const envelope = (event: Record<string, unknown>) => ({
  token: 'ignored',
  team_id: 'T0AAA111',
  api_app_id: 'A0AAA111',
  event,
  type: 'event_callback',
  event_id: 'Ev0AAA0001',
  event_time: 1752300000,
})

test('SLACK_EVENT_KINDS is the approved four', () => {
  assert.deepEqual([...SLACK_EVENT_KINDS], ['app_mention', 'message.im', 'message.channels', 'slash_command'])
})

test('normalizes an app_mention event_callback', () => {
  const result = normalizeSlackEventPayload(envelope({
    type: 'app_mention', user: 'U0USER111', text: '<@U0BOT9999> summarize today',
    ts: '1752300000.000100', channel: 'C0CHAN111', thread_ts: '1752299000.000100', event_ts: '1752300000.000100',
  }))
  assert.ok(result)
  assert.equal(result.input.kind, 'app_mention')
  assert.equal(result.input.text, '<@U0BOT9999> summarize today')
  assert.equal(result.input.user, 'U0USER111')
  assert.equal(result.input.channel, 'C0CHAN111')
  assert.equal(result.input.ts, '1752300000.000100')
  assert.equal(result.input.thread_ts, '1752299000.000100')
  assert.equal(result.input.team, 'T0AAA111')
  assert.equal(result.dedupId, 'Ev0AAA0001')
  assert.equal(result.authorBotId, undefined)
})

test('normalizes a DM (message + channel_type im) and a channel message', () => {
  const dm = normalizeSlackEventPayload(envelope({
    type: 'message', channel_type: 'im', user: 'U0USER111', text: 'hello bot',
    ts: '1752300001.000200', channel: 'D0DM11111',
  }))
  assert.equal(dm?.input.kind, 'message.im')
  const chan = normalizeSlackEventPayload(envelope({
    type: 'message', channel_type: 'channel', user: 'U0USER111', text: 'deploy please',
    ts: '1752300002.000300', channel: 'C0CHAN111',
  }))
  assert.equal(chan?.input.kind, 'message.channels')
  assert.equal(chan?.input.thread_ts, undefined)
})

test('surfaces bot_id for the echo guard; drops subtyped/unsupported events', () => {
  const bot = normalizeSlackEventPayload(envelope({
    type: 'message', channel_type: 'channel', bot_id: 'B0BOT9999', text: 'I am a bot',
    ts: '1752300003.000400', channel: 'C0CHAN111',
  }))
  assert.equal(bot?.authorBotId, 'B0BOT9999')
  // message_changed / channel_join etc. are edits and noise, not new input
  assert.equal(normalizeSlackEventPayload(envelope({ type: 'message', subtype: 'message_changed', channel_type: 'channel', ts: '1', channel: 'C1' })), null)
  assert.equal(normalizeSlackEventPayload(envelope({ type: 'reaction_added', user: 'U1' })), null)
  assert.equal(normalizeSlackEventPayload(envelope({ type: 'message', channel_type: 'mpim', user: 'U1', text: 'x', ts: '1', channel: 'G1' })), null)
  assert.equal(normalizeSlackEventPayload({ type: 'url_verification', challenge: 'x' }), null)
  assert.equal(normalizeSlackEventPayload(null), null)
})

test('normalizes a slash-command form payload', () => {
  const result = normalizeSlackCommandPayload({
    token: 'ignored', team_id: 'T0AAA111', channel_id: 'C0CHAN111', channel_name: 'general',
    user_id: 'U0USER111', command: '/deploy', text: 'prod eu-west',
    response_url: 'https://hooks.slack.com/commands/T0AAA111/123/abc',
    trigger_id: '13345224609.738474920.8088930838d88f008e0', api_app_id: 'A0AAA111',
  })
  assert.ok(result)
  assert.equal(result.input.kind, 'slash_command')
  assert.equal(result.input.command, '/deploy')
  assert.equal(result.input.text, 'prod eu-west')
  assert.equal(result.input.channel, 'C0CHAN111')
  assert.equal(result.input.channelName, 'general')
  assert.equal(result.input.response_url, 'https://hooks.slack.com/commands/T0AAA111/123/abc')
  assert.equal(result.input.ts, '')
  assert.equal(result.dedupId, '13345224609.738474920.8088930838d88f008e0')
  assert.equal(normalizeSlackCommandPayload({ team_id: 'T1' }), null) // no command → not a slash payload
})

test('drops a forged non-hooks.slack.com response_url at ingress (SSRF defense in depth)', () => {
  const base = {
    token: 'ignored', team_id: 'T0AAA111', channel_id: 'C0CHAN111', user_id: 'U0USER111',
    command: '/deploy', text: 'prod', trigger_id: '13345224609.738474920.8088930838d88f008e0', api_app_id: 'A0AAA111',
  }
  const ssrf = normalizeSlackCommandPayload({ ...base, response_url: 'http://169.254.169.254/latest/meta-data/' })
  assert.ok(ssrf)
  assert.equal(ssrf.input.response_url, undefined)

  const evil = normalizeSlackCommandPayload({ ...base, response_url: 'https://evil.example.com/webhook' })
  assert.ok(evil)
  assert.equal(evil.input.response_url, undefined)

  const notHttps = normalizeSlackCommandPayload({ ...base, response_url: 'http://hooks.slack.com/commands/T/1/a' })
  assert.ok(notHttps)
  assert.equal(notHttps.input.response_url, undefined)

  const ok = normalizeSlackCommandPayload({ ...base, response_url: 'https://hooks.slack.com/commands/T0AAA111/123/abc' })
  assert.equal(ok?.input.response_url, 'https://hooks.slack.com/commands/T0AAA111/123/abc')
})
