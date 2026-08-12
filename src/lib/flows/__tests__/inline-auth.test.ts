/**
 * Classifying inline auth values. The whole retirement hinges on this one
 * distinction, so the mixed and edge cases matter more than the happy path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasInlineLiteralSecret, inlineLiteralSecretNodes, isRuntimeReference, literalAuthSecrets, literalSensitiveHeaders, stripInlineLiteralSecrets } from '../inline-auth'
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

test('the persistence gate covers URL, query, body, cookies, and tool args', () => {
  assert.deepEqual(inlineLiteralSecretNodes({
    nodes: [
      {
        id: 'http-1',
        type: 'http',
        data: {
          url: 'https://user:pass@example.com/x?api_key=url-secret',
          query: JSON.stringify({ access_token: 'query-secret', page: 1 }),
          body: JSON.stringify({ nested: { client_secret: 'body-secret' } }),
          cookies: { session_id: 'cookie-secret' },
        },
      },
      { id: 'tool-1', type: 'tool', data: { args: JSON.stringify({ token: 'tool-secret' }) } },
    ],
  }), [
    {
      nodeId: 'http-1',
      fields: ['url.userinfo', 'url.query.api_key', 'query.access_token', 'body.nested.client_secret', 'cookies.session_id'],
    },
    { nodeId: 'tool-1', fields: ['args.token'] },
  ])
})

test('runtime references remain allowed in every credential-shaped location', () => {
  assert.deepEqual(inlineLiteralSecretNodes({
    nodes: [{
      id: 'http-1',
      type: 'http',
      data: {
        url: 'https://example.com/x?api_key={{trigger.input.key}}',
        query: JSON.stringify({ access_token: '{{trigger.input.token}}' }),
        body: JSON.stringify({ client_secret: '{{step.auth.output}}' }),
      },
    }],
  }), [])
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

// ── stripInlineLiteralSecrets (import-only scrub) ───────────────────────────

test('stripping removes every literal secret and the detector agrees', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      {
        id: 'h', type: 'http',
        data: {
          label: 'Call API',
          method: 'GET',
          url: 'https://joe:BASIC_SECRET@api/x?api_key=URL_SECRET&page=2',
          auth: { type: 'bearer', token: 'sk_live_abc' },
          headers: JSON.stringify({ 'X-Shopify-Access-Token': 'shpat_123', Accept: 'application/json' }),
          query: JSON.stringify({ access_token: 'QUERY_SECRET', q: 'leads' }),
          body: JSON.stringify({ client_secret: 'BODY_SECRET', payload: 'keep' }),
        },
      },
      { id: 't', type: 'tool', data: { label: 'Tool', connectionId: 'c1', toolName: 'send', args: JSON.stringify({ token: 'TOOL_SECRET', text: 'hi' }) } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'h' }],
  }
  const { graph: stripped, warnings } = stripInlineLiteralSecrets(graph)
  const json = JSON.stringify(stripped)
  for (const secret of ['BASIC_SECRET', 'URL_SECRET', 'sk_live_abc', 'shpat_123', 'QUERY_SECRET', 'BODY_SECRET', 'TOOL_SECRET']) {
    assert.equal(json.includes(secret), false, `left ${secret} behind`)
  }
  // Non-secret content survives so the steps stay rebuildable.
  assert.equal(json.includes('page=2'), true)
  assert.equal(json.includes('application/json'), true)
  assert.equal(json.includes('leads'), true)
  assert.equal(json.includes('keep'), true)
  assert.equal(json.includes('hi'), true)
  // The result passes the same gate interactive saves enforce.
  assert.deepEqual(inlineLiteralSecretNodes(stripped), [])
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /Call API/)
  assert.match(warnings.join(' '), /attach a saved credential/i)
})

test('stripping is a no-op for a clean graph and keeps runtime references', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      {
        id: 'h', type: 'http',
        data: { label: 'Ref', method: 'GET', url: 'https://api/x', auth: { type: 'bearer', token: '{{trigger.input.key}}' } },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'h' }],
  }
  const { graph: stripped, warnings } = stripInlineLiteralSecrets(graph)
  assert.deepEqual(warnings, [])
  assert.equal(JSON.stringify(stripped).includes('{{trigger.input.key}}'), true)
})

test('a header the export redactor would catch is caught at save time too', () => {
  assert.deepEqual(literalSensitiveHeaders(JSON.stringify({ 'X-Shopify-Access-Token': 'shpat_123' })), ['X-Shopify-Access-Token'])
  assert.deepEqual(literalSensitiveHeaders(JSON.stringify({ 'X-Request-Id': 'abc' })), [])
})
