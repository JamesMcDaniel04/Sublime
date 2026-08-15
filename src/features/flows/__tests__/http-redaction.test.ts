/**
 * Redaction on BOTH sides of an http step.
 *
 * Inputs (persisted run row / audit / approval prompt) previously redacted
 * only headers+auth — cookie, url userinfo, ?api_key=, and credential-named
 * query/body fields drifted back in, contradicting redactHttpStepInput's own
 * "single source of truth" docstring vs the export redactor.
 *
 * Outputs previously persisted with ZERO redaction. The sharp one: a query
 * credential the platform injected (apiKeyQuery) lands verbatim in
 * `output.url`, and a second node can post {{Step.output.url}} to any host —
 * laundering the secret past the domain allowlist. Response headers can echo
 * set-cookie / a reflected Authorization.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactHttpStepInput, redactHttpStepOutput } from '../http'

test('input: a cookie value is redacted (a credential by definition)', () => {
  const out = redactHttpStepInput({ method: 'GET', cookie: 'session=abc123secret' })
  assert.notEqual(out.cookie, 'session=abc123secret')
  assert.match(String(out.cookie), /redacted/)
})

test('input: url userinfo and credential query params are stripped', () => {
  const out = redactHttpStepInput({ url: 'https://u:p@api.example.com/x?api_key=SEKRET&page=2' })
  const url = String(out.url)
  assert.ok(!url.includes('SEKRET'), 'api_key leaked in persisted url')
  assert.ok(!url.includes('u:p@'), 'userinfo leaked in persisted url')
  assert.ok(url.includes('page=2'), 'non-secret query param was lost')
})

test('input: credential-named body/query fields are redacted, data preserved', () => {
  const out = redactHttpStepInput({
    query: '{"access_token":"SEKRET","limit":10}',
    body: { client_secret: 'SEKRET2', name: 'widget' },
  })
  assert.ok(!JSON.stringify(out).includes('SEKRET'), 'token leaked from query')
  assert.ok(!JSON.stringify(out).includes('SEKRET2'), 'client_secret leaked from body')
  assert.ok(JSON.stringify(out).includes('widget'), 'non-secret body field was lost')
})

test('input: a template url is left intact (no literal secret to strip)', () => {
  const out = redactHttpStepInput({ url: 'https://api.example.com/{{trigger.path}}?key={{var.k}}' })
  assert.equal(out.url, 'https://api.example.com/{{trigger.path}}?key={{var.k}}')
})

test('output: an injected query credential is stripped from output.url', () => {
  const out = redactHttpStepOutput({
    ok: true, status: 200, statusText: 'OK',
    url: 'https://api.example.com/data?api_key=INJECTED_SECRET&cursor=9',
    headers: {}, body: { items: [] }, bodyText: '{"items":[]}',
  })
  const url = String((out as { url: string }).url)
  assert.ok(!url.includes('INJECTED_SECRET'), 'query credential laundered into output.url')
  assert.ok(url.includes('cursor=9'), 'non-secret cursor param was lost')
})

test('output: set-cookie and echoed Authorization headers are redacted', () => {
  const out = redactHttpStepOutput({
    ok: true, status: 200, statusText: 'OK', url: 'https://api.example.com/x',
    headers: { 'set-cookie': 'sid=secret; HttpOnly', authorization: 'Bearer echoed-token', 'content-type': 'application/json' },
    body: {}, bodyText: '{}',
  }) as { headers: Record<string, string> }
  assert.ok(!JSON.stringify(out.headers).includes('secret'), 'set-cookie survived into output')
  assert.ok(!JSON.stringify(out.headers).includes('echoed-token'), 'echoed Authorization survived into output')
  assert.equal(out.headers['content-type'], 'application/json', 'benign header was lost')
})

test('output: response BODY data is preserved (redaction must not break chaining)', () => {
  // A legitimate token-fetch step must still hand its access_token downstream —
  // the output-body is deliberately NOT deep-redacted, unlike the export copy.
  const out = redactHttpStepOutput({
    ok: true, status: 200, statusText: 'OK', url: 'https://auth.example.com/token',
    headers: {}, body: { access_token: 'real-token-for-next-step', expires_in: 3600 }, bodyText: '',
  }) as { body: { access_token: string } }
  assert.equal(out.body.access_token, 'real-token-for-next-step')
})

test('output: a non-object output passes through untouched', () => {
  assert.equal(redactHttpStepOutput('plain text' as never), 'plain text')
  assert.equal(redactHttpStepOutput(null as never), null)
})
