import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remediationForFailedRun } from '../failure-remediation'

test('URL host failures require user input and never authorize graph mutation', () => {
  const result = remediationForFailedRun({ status: 'failed', steps: [{ nodeId: 'enrich', status: 'failed', error: 'Could not resolve URL host' }] })!
  assert.equal(result.kind, 'user_action')
  assert.equal(result.nodeId, 'enrich')
  assert.match(result.copilotPrompt, /Do not change the graph/)
  assert.ok(result.userSteps.length >= 2)
})

test('credential failures give reconnection instructions', () => {
  const result = remediationForFailedRun({ status: 'failed', error: 'Slack invalid_auth: token expired' })!
  assert.equal(result.kind, 'user_action')
  assert.match(result.userSteps.join(' '), /reconnect/i)
})

test('transient failures offer bounded reliability tuning', () => {
  const result = remediationForFailedRun({ status: 'failed', steps: [{ nodeId: 'api', status: 'failed', error: '429 Too Many Requests' }] })!
  assert.equal(result.kind, 'retry_tuning')
  assert.match(result.copilotPrompt, /bounded retries/)
})

test('malformed payload failures are safe-fix candidates', () => {
  const result = remediationForFailedRun({ status: 'failed', error: 'Invalid JSON body: expected an object' })!
  assert.equal(result.kind, 'safe_fix')
})

test('non-failed runs have no remediation', () => {
  assert.equal(remediationForFailedRun({ status: 'succeeded', error: 'old error' }), null)
})

test('missing-connection failures route to connect-integration guidance with a demo-run offer', () => {
  for (const message of [
    'No connected slack account is available — connect one in Integrations.',
    'Slack is not configured for this workspace.',
    'This step still holds the template placeholder "slack" — it was never bound to a real connection.',
  ]) {
    const result = remediationForFailedRun({ status: 'failed', steps: [{ nodeId: 'send', status: 'failed', error: message }] })!
    assert.equal(result.kind, 'user_action', message)
    assert.match(result.title, /[Cc]onnect/)
    assert.match(result.copilotPrompt, /demo run/i)
    assert.match(result.userSteps.join(' '), /Integrations/)
  }
})
