import { test } from 'node:test'
import assert from 'node:assert/strict'
import { knowledgeCaptureSettings, shouldCaptureKnowledge } from '../settings'
import { knowledgeText, redactKnowledgeValue } from '../store'

test('durable knowledge capture is default-on for every retained source', () => {
  const settings = knowledgeCaptureSettings(null)
  assert.deepEqual(settings, {
    captureEnabled: true,
    captureAgentRuns: true,
    captureFlowRuns: true,
    captureConnectedData: true,
    retainOnDisconnect: true,
    zeroDataRetention: false,
  })
  assert.equal(shouldCaptureKnowledge(settings, 'agent_run'), true)
  assert.equal(shouldCaptureKnowledge(settings, 'flow_run'), true)
  assert.equal(shouldCaptureKnowledge(settings, 'connection_profile'), true)
  assert.equal(shouldCaptureKnowledge(settings, 'activity_sync'), true)
})

test('enterprise zero-retention overrides every capture toggle', () => {
  const settings = knowledgeCaptureSettings({ zeroDataRetention: true })
  assert.equal(shouldCaptureKnowledge(settings, 'upload'), false)
  assert.equal(shouldCaptureKnowledge(settings, 'agent_run'), false)
  assert.equal(shouldCaptureKnowledge(settings, 'flow_run'), false)
  assert.equal(shouldCaptureKnowledge(settings, 'activity_sync'), false)
})

test('knowledge redaction removes credential fields and inline secrets', () => {
  assert.deepEqual(
    redactKnowledgeValue({
      customer: 'Acme',
      access_token: 'very-secret-token',
      nested: { password: 'hunter2', outcome: 'renewed' },
    }),
    {
      customer: 'Acme',
      access_token: '[REDACTED]',
      nested: { password: '[REDACTED]', outcome: 'renewed' },
    },
  )
  const text = knowledgeText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')
  assert.equal(text.includes('abcdefghijklmnopqrstuvwxyz'), false)
  assert.match(text, /\[REDACTED\]/)
})
