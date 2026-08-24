import test from 'node:test'
import assert from 'node:assert/strict'
import { requestReplyText } from '../request-slack-reply'

const base = { agentName: 'Riley', runUrl: 'https://app.test/agents?run=r1' }

test('a completed request replies with the agent output and a run link', () => {
  const text = requestReplyText({ ...base, status: 'completed', result: 'Acme renewal is at risk.' })
  assert.match(text!, /Acme renewal is at risk\./)
  assert.match(text!, /View the run/)
})

test('a completed request with no output says so rather than replying blank', () => {
  const text = requestReplyText({ ...base, status: 'completed', result: '   ' })
  assert.match(text!, /produced no output/i)
})

test('a decline reads as the agent judging, not as an error', () => {
  // A correct refusal must not look like a bug report, or people learn to
  // escalate the thing the design does on purpose.
  const text = requestReplyText({ ...base, status: 'declined', error: 'that is outside renewal monitoring.' })
  assert.doesNotMatch(text!, /:warning:/)
  assert.doesNotMatch(text!, /failed|error/i)
  assert.match(text!, /didn't take this on/i)
})

test('a decline carries no run link — there is nothing to inspect', () => {
  // deliverRequestSlackReply passes runUrl: null for declines; prove the
  // formatter honors an absent link rather than printing a bare tail.
  const text = requestReplyText({ agentName: 'Riley', status: 'declined', error: 'out of scope.', runUrl: null })
  assert.doesNotMatch(text!, /View the run/)
})

test('a failure is marked and its reason truncated', () => {
  const text = requestReplyText({ ...base, status: 'failed', error: 'x'.repeat(500) })
  assert.match(text!, /:warning:/)
  assert.ok(text!.length < 500, 'reason is bounded')
})

test('a waiting request asks the agent question and says where to answer', () => {
  // Slack thread continuation for requests is not built yet, so a question
  // posted with no route to an answer would be a dead end.
  const text = requestReplyText({ ...base, status: 'waiting', question: 'Which Acme contract?' })
  assert.match(text!, /Which Acme contract\?/)
  assert.match(text!, /Answer in Sublime/)
})

test('a waiting request with no question still says something actionable', () => {
  const text = requestReplyText({ ...base, status: 'waiting', question: null })
  assert.match(text!, /needs something from you/i)
})

test('long output is truncated with an ellipsis, not dropped', () => {
  const text = requestReplyText({ ...base, status: 'completed', result: 'y'.repeat(5000) })
  assert.match(text!, /…/)
  assert.ok(text!.length < 3200)
})
