import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  providerIdempotencyKey,
  sideEffectKey,
  sideEffectRecoveryDecision,
  sideEffectRequestHash,
} from '../side-effect-ledger'

test('provider committed but response was lost: an unprotected write is never replayed', () => {
  assert.equal(sideEffectRecoveryDecision('claimed', 'unsafe_write'), 'block_ambiguous')
  assert.equal(sideEffectRecoveryDecision('ambiguous', 'unsafe_write'), 'block_ambiguous')
})

test('provider committed but response was lost: a provider-keyed write may resume safely', () => {
  assert.equal(sideEffectRecoveryDecision('claimed', 'idempotent_write'), 'execute')
  const key = sideEffectKey({ flowRunId: 'run-1', nodeId: 'send', iterationPath: '3', kind: 'tool' })
  assert.equal(providerIdempotencyKey(key), providerIdempotencyKey(key))
})

test('a stored success is replayed and stable hashes ignore object key order', () => {
  assert.equal(sideEffectRecoveryDecision('succeeded', 'unsafe_write'), 'replay')
  assert.equal(sideEffectRequestHash({ b: 2, a: 1 }), sideEffectRequestHash({ a: 1, b: 2 }))
})
