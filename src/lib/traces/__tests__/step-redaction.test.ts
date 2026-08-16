import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toProcessSteps, type WorkflowStepRow } from '@/lib/traces/load'

/**
 * Step rows are the plaintext reservoir: the execution path persists tool
 * input/output in full (agent replay hashes the input and re-uses the output,
 * so neither can be redacted at write time). Redaction therefore has to happen
 * where the row is SERVED — this is that boundary.
 */

const row = (over: Partial<WorkflowStepRow>): WorkflowStepRow => ({
  id: 's1',
  executionId: 'e1',
  node: 'slack.postMessage',
  status: 'succeeded',
  input: null,
  output: null,
  error: null,
  startedAt: null,
  completedAt: null,
  ...over,
})

test('credential-named keys in a served step output are redacted', () => {
  const [step] = toProcessSteps([
    row({ output: { user: 'ada', access_token: 'xoxb-real-token-value-here' } }),
  ])
  assert.deepEqual(step.output, { user: 'ada', access_token: 'redacted' })
})

test('credential-named keys nested deep in a served step output are redacted', () => {
  const [step] = toProcessSteps([
    row({ output: { records: [{ name: 'ada', auth: { client_secret: 'SHHH' } }] } }),
  ])
  assert.deepEqual(step.output, { records: [{ name: 'ada', auth: 'redacted' }] })
})

test('a served step input is redacted', () => {
  const [step] = toProcessSteps([row({ input: { url: 'https://api.example.com', api_key: 'SECRET' } })])
  assert.deepEqual(step.input, { url: 'https://api.example.com', api_key: 'redacted' })
})

test('a served step error is redacted', () => {
  const [step] = toProcessSteps([row({ error: { message: 'denied', token: 'SECRET' } })])
  assert.deepEqual(step.error, { message: 'denied', token: 'redacted' })
})

test('non-credential payload data survives redaction intact', () => {
  const payload = { id: 'rec_123', email: 'ada@example.com', count: 7, nested: { ok: true } }
  const [step] = toProcessSteps([row({ output: payload })])
  assert.deepEqual(step.output, payload)
})

test('credentials inside a JSON-encoded string output are redacted', () => {
  const [step] = toProcessSteps([row({ output: JSON.stringify({ refresh_token: 'SECRET', keep: 1 }) })])
  assert.deepEqual(JSON.parse(String(step.output)), { refresh_token: 'redacted', keep: 1 })
})

test('step identity fields are untouched by redaction', () => {
  const [step] = toProcessSteps([row({ node: 'http.request', status: 'failed' })])
  assert.equal(step.id, 's1')
  assert.equal(step.node, 'http.request')
  assert.equal(step.status, 'failed')
})
