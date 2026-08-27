import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authHeadersFor, buildExternalPayload, callbackUrlFor, describeExternalBinding, encryptExternalAuth,
  interpretCallbackBody, interpretExternalResponse, MAX_WORK_ENTRIES, mintCallbackToken, parseWorkEntries, verifyCallbackToken,
} from '../external-agent'

process.env.ALLOW_UNENCRYPTED_SECRETS = process.env.ALLOW_UNENCRYPTED_SECRETS ?? '1'

test('a callback token verifies only against its own hash, and never a forgery', () => {
  const a = mintCallbackToken(); const b = mintCallbackToken()
  assert.equal(verifyCallbackToken(a.token, a.hash), true)
  assert.equal(verifyCallbackToken(b.token, a.hash), false)
  assert.equal(verifyCallbackToken('', a.hash), false)
  assert.equal(verifyCallbackToken(a.token, null), false)
  assert.notEqual(a.token, b.token)
})

test('the callback URL is absolute when an app origin is known, and documented-relative otherwise', () => {
  assert.equal(callbackUrlFor('agt_1', 'https://app.test/'), 'https://app.test/api/agents/agt_1/external/callback')
  assert.equal(callbackUrlFor('agt_1', undefined), '/api/agents/agt_1/external/callback')
})

test('200 with output answers inline; 202 accepts; anything else fails with the status', () => {
  assert.deepEqual(interpretExternalResponse(200, { output: 'hi' }), { kind: 'completed', output: 'hi', work: [] })
  assert.deepEqual(interpretExternalResponse(200, { output: { a: 1 } }), { kind: 'completed', output: '{"a":1}', work: [] })
  assert.deepEqual(interpretExternalResponse(202, null), { kind: 'accepted' })
  assert.equal(interpretExternalResponse(200, { status: 'failed', error: 'nope' }).kind, 'failed')
  assert.equal(interpretExternalResponse(200, {}).kind, 'failed', 'an answer with no output is a failure, not an empty success')
  assert.match((interpretExternalResponse(503, null) as { error: string }).error, /503/)
})

test('the callback body follows the same rules', () => {
  assert.deepEqual(interpretCallbackBody({ output: 'done' }), { kind: 'completed', output: 'done', work: [] })
  assert.equal(interpretCallbackBody({ status: 'failed', error: 'x' }).kind, 'failed')
})

test('auth is stored encrypted and rendered as the right header', () => {
  const bearer = encryptExternalAuth({ authType: 'bearer', secret: 's3cret' })
  assert.notEqual(bearer.secretEnc, 's3cret', 'ciphertext at rest')
  assert.deepEqual(authHeadersFor({ authType: 'bearer', authConfig: bearer }), { authorization: 'Bearer s3cret' })
  const header = encryptExternalAuth({ authType: 'header', headerName: 'X-Agent-Key', secret: 'k' })
  assert.deepEqual(authHeadersFor({ authType: 'header', authConfig: header }), { 'X-Agent-Key': 'k' })
  assert.deepEqual(authHeadersFor({ authType: 'none', authConfig: encryptExternalAuth({ authType: 'none', secret: 'ignored' }) }), {})
})

test('describing a binding never leaks the secret', () => {
  const described = describeExternalBinding({ endpointUrl: 'https://agent.example.com/run', authType: 'bearer', authConfig: encryptExternalAuth({ authType: 'bearer', secret: 'zzz' }), timeoutMinutes: 10 })
  assert.equal(described?.host, 'agent.example.com')
  assert.equal(described?.hasSecret, true)
  assert.equal(JSON.stringify(described).includes('zzz'), false)
  assert.equal(describeExternalBinding(null), null)
})

test('work entries are bounded and fail-safe: junk dropped, fields trimmed, list capped', () => {
  const parsed = parseWorkEntries([
    { subject: 'Fix login', produced: 'https://github.com/acme/app/pull/42', subjectRef: 'acme/app#42', body: 'diff', assigneeHint: 'jamie@acme.com' },
    { subject: '', produced: 'x' },              // no subject → dropped
    { subject: 'no produced' },                  // no produced → dropped
    'garbage', null, 7,
    { subject: 'html', produced: 'p', bodyFormat: 'html' },
    { subject: 'long', produced: 'p'.repeat(1000) },
  ])
  assert.equal(parsed.length, 3)
  assert.deepEqual(parsed[0], { subject: 'Fix login', produced: 'https://github.com/acme/app/pull/42', body: 'diff', bodyFormat: 'markdown', subjectRef: 'acme/app#42', assigneeHint: 'jamie@acme.com' })
  assert.equal(parsed[1].bodyFormat, 'html')
  assert.equal(parsed[2].produced.length, 200, 'fields are trimmed to a bound')
  assert.equal(parseWorkEntries(Array.from({ length: 50 }, (_, i) => ({ subject: `s${i}`, produced: 'p' }))).length, MAX_WORK_ENTRIES)
  assert.deepEqual(parseWorkEntries('nope'), [])
  assert.deepEqual(parseWorkEntries(undefined), [])
})

test('a completed answer carries its work; a failed one carries none', () => {
  const done = interpretExternalResponse(200, { output: 'Opened PR #42', work: [{ subject: 's', produced: 'p' }] })
  assert.equal(done.kind, 'completed')
  assert.equal((done as { work: unknown[] }).work.length, 1)
  assert.deepEqual((interpretExternalResponse(200, { output: 'plain' }) as { work: unknown[] }).work, [])
  assert.equal((interpretCallbackBody({ output: 'ok', work: [{ subject: 's', produced: 'p' }] }) as { work: unknown[] }).work.length, 1)
})

test('the payload names its protocol and carries the ask verbatim', () => {
  const payload = buildExternalPayload({ runId: 'r', agentId: 'a', request: { id: 'q', text: 'hello', requesterName: 'Jamie' }, objective: 'o', input: 'hello', goalId: 'g', callbackUrl: 'u', callbackToken: 't' })
  assert.equal(payload.protocol, 'sublime-external-agent/1')
  assert.equal(payload.request?.text, 'hello')
})
