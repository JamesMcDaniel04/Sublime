/**
 * Classifying inline auth values. The whole retirement hinges on this one
 * distinction, so the mixed and edge cases matter more than the happy path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasInlineLiteralSecret, inlineLiteralSecretNodes, isRuntimeReference, literalAuthSecrets, literalSensitiveHeaders } from '../inline-auth'
import { validateFlowGraph } from '../validate'
import type { FlowGraph } from '../graph'

test('a bare literal is not a runtime reference', () => {
  assert.equal(isRuntimeReference('sk_live_abc'), false)
})

test('a value that is entirely one token IS a runtime reference', () => {
  assert.equal(isRuntimeReference('{{trigger.input.apiKey}}'), true)
  assert.equal(isRuntimeReference('  {{ step.n1.output.token }}  '), true)
})

test('a mixed value is treated as a literal — the safe reading', () => {
  // "Bearer {{x}}" contains a literal prefix; more importantly, treating an
  // ambiguous value as a secret costs a needless migration, while the opposite
  // error leaves a real secret in the graph.
  assert.equal(isRuntimeReference('Bearer {{trigger.input.key}}'), false)
  assert.equal(isRuntimeReference('{{a}}{{b}}'), false)
  assert.equal(isRuntimeReference('{{a}} trailing'), false)
})

test('literalAuthSecrets names only the secret-bearing fields', () => {
  const auth = { type: 'basic', username: 'joe', password: 'pw' }
  // username is metadata, not a secret — it must not be flagged.
  assert.deepEqual(literalAuthSecrets(auth), ['password'])
})

test('literalAuthSecrets covers all three secret fields', () => {
  assert.deepEqual(literalAuthSecrets({ type: 'bearer', token: 'tok' }), ['token'])
  assert.deepEqual(literalAuthSecrets({ type: 'header', name: 'X-K', value: 'v' }), ['value'])
  assert.deepEqual(
    literalAuthSecrets({ type: 'custom', password: 'p', token: 't', value: 'v' }).sort(),
    ['password', 'token', 'value'],
  )
})

test('a tokenized secret is NOT reported', () => {
  assert.deepEqual(literalAuthSecrets({ type: 'bearer', token: '{{trigger.input.key}}' }), [])
})

test('blank and absent values are not secrets', () => {
  assert.deepEqual(literalAuthSecrets({ type: 'bearer', token: '' }), [])
  assert.deepEqual(literalAuthSecrets({ type: 'bearer', token: '   ' }), [])
  assert.deepEqual(literalAuthSecrets({ type: 'bearer' }), [])
})

test('a malformed auth option does not throw', () => {
  assert.deepEqual(literalAuthSecrets(null), [])
  assert.deepEqual(literalAuthSecrets('nope'), [])
  assert.deepEqual(literalAuthSecrets([1, 2]), [])
})

test('hasInlineLiteralSecret only looks at http nodes', () => {
  assert.equal(hasInlineLiteralSecret({ type: 'http', data: { auth: { type: 'bearer', token: 'tok' } } }), true)
  assert.equal(hasInlineLiteralSecret({ type: 'http', data: { auth: { type: 'bearer', token: '{{x.y}}' } } }), false)
  assert.equal(hasInlineLiteralSecret({ type: 'http', data: {} }), false)
  // A tool node's args are redacted separately; this check is http-specific.
  assert.equal(hasInlineLiteralSecret({ type: 'tool', data: { args: '{"token":"tok"}' } }), false)
})

test('literal sensitive headers are detected case-insensitively', () => {
  assert.deepEqual(
    literalSensitiveHeaders(JSON.stringify({ Authorization: 'Bearer secret', 'X-API-Key': 'secret-2', Accept: 'application/json' })),
    ['Authorization', 'X-API-Key'],
  )
})

test('runtime-referenced sensitive headers may remain in the graph', () => {
  assert.deepEqual(literalSensitiveHeaders(JSON.stringify({ authorization: '{{trigger.input.authorization}}' })), [])
})

test('malformed or non-object header JSON is not misclassified', () => {
  assert.deepEqual(literalSensitiveHeaders('{bad'), [])
  assert.deepEqual(literalSensitiveHeaders('[]'), [])
})

test('the persistence gate reports both auth fields and sensitive headers', () => {
  assert.deepEqual(inlineLiteralSecretNodes({
    nodes: [{
      id: 'http-1',
      type: 'http',
      data: {
        auth: { type: 'basic', password: 'secret' },
        headers: JSON.stringify({ Authorization: 'Bearer secret' }),
      },
    }],
  }), [{ nodeId: 'http-1', fields: ['password', 'header:Authorization'] }])
})

// ── Validation surfacing ──────────────────────────────────────────────────────

const httpFlow = (auth: unknown, extra: Record<string, unknown> = {}): FlowGraph =>
  ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'h', type: 'http', data: { label: 'Call API', method: 'GET', url: 'https://api/x', ...(auth ? { auth } : {}), ...extra } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'h' }],
  }) as unknown as FlowGraph

test('a literal inline secret is a blocking error and points at the vault', () => {
  const result = validateFlowGraph(httpFlow({ type: 'bearer', token: 'sk_live_abc' }))
  const issue = result.errors.find((entry) => entry.code === 'INLINE_AUTH_SECRET')
  assert.ok(issue, 'no INLINE_AUTH_SECRET error')
  assert.match(issue.message, /Credentials/)
  assert.equal(result.ok, false)
})

test('a tokenized inline value produces NO warning', () => {
  const result = validateFlowGraph(httpFlow({ type: 'bearer', token: '{{trigger.input.apiKey}}' }))
  assert.equal(result.warnings.some((entry) => entry.code === 'INLINE_AUTH_SECRET'), false)
})

test('a vault-attached step produces no inline warning', () => {
  const result = validateFlowGraph(httpFlow(null, { authMode: 'generic', credentialId: 'cred_1' }))
  assert.equal(result.warnings.some((entry) => entry.code === 'INLINE_AUTH_SECRET'), false)
  assert.equal(result.errors.some((entry) => entry.code === 'MISSING_CREDENTIAL'), false)
})

test('generic auth with no credential chosen is an error', () => {
  const result = validateFlowGraph(httpFlow(null, { authMode: 'generic' }))
  assert.ok(result.errors.some((entry) => entry.code === 'MISSING_CREDENTIAL'))
})

test('a literal authorization header is a blocking validation error', () => {
  const result = validateFlowGraph(httpFlow(null, {
    headers: JSON.stringify({ Authorization: 'Bearer sk_live_abc' }),
  }))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((entry) => entry.code === 'INLINE_AUTH_SECRET'))
})
