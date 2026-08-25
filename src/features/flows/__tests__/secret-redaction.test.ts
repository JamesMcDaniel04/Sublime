/**
 * The property that makes external secrets safe to use at all.
 *
 * A vault credential never enters the graph — it is injected at the transport
 * edge. An external-store secret DOES: `{{secrets.…}}` resolves to a real
 * value that flows through step inputs and outputs. So if a step echoes it,
 * the value would be written to FlowStep.output and read back by anyone with
 * access to the run — which would make this feature strictly LESS safe than
 * the vault it complements.
 *
 * These tests pin the two halves: the secret reaches the step, and the secret
 * does not reach the database.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withSecretRedaction, redactForCurrentRun } from '@/lib/secrets/redaction-scope'
import { readPath, type FlowContext } from '../context'

const SECRET = 'sk-live-9f3a2b7c1d'

test('a step reads the real secret value, not a placeholder', () => {
  const ctx: FlowContext = {
    trigger: { input: null },
    step: {},
    secrets: { 'vault.kv/data/stripe': SECRET },
  }
  // The whole point: the step gets the REAL value, or the feature is useless.
  assert.equal(readPath(ctx, 'secrets.vault.kv/data/stripe'), SECRET)
})

test('a step output echoing the secret is scrubbed before persistence', async () => {
  await withSecretRedaction([SECRET], async () => {
    // Simulating what execute-flow's jsonValue does to every persisted value.
    const persisted = JSON.parse(JSON.stringify(redactForCurrentRun({
      status: 200,
      body: { echoed: `Authorization: Bearer ${SECRET}` },
    })))
    assert.doesNotMatch(JSON.stringify(persisted), new RegExp(SECRET))
  })
})

// The failure path leaks just as readily as the success path — an HTTP client
// that puts the request into its error message would otherwise write the
// secret to FlowRun.error, where the runs UI displays it.
test('a secret appearing in an error message is scrubbed too', async () => {
  await withSecretRedaction([SECRET], async () => {
    const error = redactForCurrentRun(`Request failed: Bearer ${SECRET} rejected`) as string
    assert.doesNotMatch(error, new RegExp(SECRET))
  })
})

test('a run that resolved no secrets persists its output unchanged', async () => {
  await withSecretRedaction([], async () => {
    const value = { body: 'nothing secret here' }
    assert.deepEqual(redactForCurrentRun(value), value)
  })
})
