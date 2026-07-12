import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatSlackReply, SLACK_REPLY_MAX_CHARS } from '@/lib/slack/format'

test('strings pass through untouched', () => {
  assert.equal(formatSlackReply('Deployed *v1.2* to prod'), 'Deployed *v1.2* to prod')
})

test('objects/arrays become fenced JSON', () => {
  assert.equal(formatSlackReply({ ok: true, count: 2 }), '```json\n' + JSON.stringify({ ok: true, count: 2 }, null, 2) + '\n```')
  assert.ok(formatSlackReply([1, 2, 3]).startsWith('```json\n'))
})

test('null/undefined/empty degrade to a placeholder', () => {
  assert.equal(formatSlackReply(null), '_(no output)_')
  assert.equal(formatSlackReply(undefined), '_(no output)_')
  assert.equal(formatSlackReply(''), '_(no output)_')
})

test('long output truncates to 4k chars with a run-link suffix', () => {
  const long = 'x'.repeat(SLACK_REPLY_MAX_CHARS + 500)
  const out = formatSlackReply(long, { runUrl: 'https://app.test/flows/f1/activity' })
  assert.ok(out.length <= SLACK_REPLY_MAX_CHARS)
  assert.ok(out.endsWith('_…truncated — full output: https://app.test/flows/f1/activity_'))
  const noLink = formatSlackReply(long)
  assert.ok(noLink.length <= SLACK_REPLY_MAX_CHARS)
  assert.ok(noLink.endsWith('_…truncated_'))
})
