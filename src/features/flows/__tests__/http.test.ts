import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareHttpRequest, responseOutput, withBearerAuthorization, redactAuthHeaders, redactHttpStepInput } from '../http'

test('prepareHttpRequest appends query params and sends JSON bodies', () => {
  const request = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/accounts',
    query: { tag: ['a', 'b'], active: true },
    headers: { authorization: 'Bearer token' },
    body: { account: 'Acme' },
    bodyMode: 'json',
  })
  assert.equal(request.url, 'https://api.example.com/accounts?tag=a&tag=b&active=true')
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(request.init.headers, { authorization: 'Bearer token', 'content-type': 'application/json' })
  assert.equal(request.init.body, '{"account":"Acme"}')
})

test('prepareHttpRequest sends a Cookie header from the cookie field', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com/me',
    cookie: 'session=abc; theme=dark',
  })
  assert.equal((request.init.headers as Record<string, string>).cookie, 'session=abc; theme=dark')
})

test('an explicit Cookie header wins over the cookie field', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com/me',
    headers: { Cookie: 'from=header' },
    cookie: 'from=field',
  })
  const headers = request.init.headers as Record<string, string>
  const cookieVals = Object.entries(headers).filter(([k]) => k.toLowerCase() === 'cookie').map(([, v]) => v)
  assert.deepEqual(cookieVals, ['from=header'])
})

test('prepareHttpRequest omits body for GET and supports text body mode', () => {
  const get = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/search', body: '{"ignored":true}', bodyMode: 'json' })
  assert.equal(get.init.body, undefined)

  const post = prepareHttpRequest({ method: 'POST', url: 'https://api.example.com/hook', body: 'hello', bodyMode: 'text' })
  assert.equal(post.init.body, 'hello')
  assert.deepEqual(post.init.headers, {})
})

test('prepareHttpRequest validates object-shaped headers and query params', () => {
  assert.throws(() => prepareHttpRequest({ url: 'https://api.example.com', headers: '[]' }), /Headers/)
  assert.throws(() => prepareHttpRequest({ url: 'https://api.example.com', query: '"bad"' }), /Query/)
})

test('prepareHttpRequest preserves existing query params and clamps request options', () => {
  const request = prepareHttpRequest({
    method: 'PATCH',
    url: 'https://api.example.com/search?existing=1',
    query: '{"tag":["a","b"],"active":true}',
    headers: '{"x-count": 5}',
    timeoutMs: 999999,
    failOnHttpError: false,
    responseType: 'text',
    body: '{"ok":true}',
  })
  assert.equal(request.url, 'https://api.example.com/search?existing=1&tag=a&tag=b&active=true')
  assert.deepEqual(request.init.headers, { 'x-count': '5', 'content-type': 'application/json' })
  assert.equal(request.timeoutMs, 120000)
  assert.equal(request.failOnHttpError, false)
  assert.equal(request.responseType, 'text')
})

test('prepareHttpRequest rejects invalid JSON bodies when JSON mode is explicit', () => {
  assert.throws(
    () => prepareHttpRequest({ method: 'POST', url: 'https://api.example.com', bodyMode: 'json', body: '{broken' }),
    /not valid JSON/,
  )
})

test('queryArrayFormat controls how array params serialize', () => {
  const base = { method: 'GET', url: 'https://api.example.com/items', query: { tag: ['a', 'b'], one: 1 } }
  assert.equal(
    prepareHttpRequest(base).url,
    'https://api.example.com/items?tag=a&tag=b&one=1',
  )
  assert.equal(
    prepareHttpRequest({ ...base, queryArrayFormat: 'brackets' }).url,
    `https://api.example.com/items?${encodeURIComponent('tag[]')}=a&${encodeURIComponent('tag[]')}=b&one=1`,
  )
  assert.equal(
    prepareHttpRequest({ ...base, queryArrayFormat: 'indices' }).url,
    `https://api.example.com/items?${encodeURIComponent('tag[0]')}=a&${encodeURIComponent('tag[1]')}=b&one=1`,
  )
  assert.equal(
    prepareHttpRequest({ ...base, queryArrayFormat: 'comma' }).url,
    `https://api.example.com/items?tag=${encodeURIComponent('a,b')}&one=1`,
  )
})

test('auth type basic sets a Basic Authorization header', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com',
    auth: { type: 'basic', username: 'user', password: 'pa:ss' },
  })
  const headers = request.init.headers as Record<string, string>
  assert.equal(headers.authorization, `Basic ${Buffer.from('user:pa:ss').toString('base64')}`)
})

test('auth type bearer sets a Bearer Authorization header', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com',
    auth: { type: 'bearer', token: 'tok-9' },
  })
  assert.equal((request.init.headers as Record<string, string>).authorization, 'Bearer tok-9')
})

test('an explicit Authorization header wins over the auth option', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com',
    headers: { Authorization: 'Bearer mine' },
    auth: { type: 'basic', username: 'user', password: 'pass' },
  })
  const headers = request.init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer mine')
  assert.equal(headers.authorization, undefined)
})

test('auth type header sets a custom header without clobbering an explicit one', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com',
    auth: { type: 'header', name: 'X-Api-Key', value: 'secret-1' },
  })
  assert.equal((request.init.headers as Record<string, string>)['X-Api-Key'], 'secret-1')

  const explicit = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com',
    headers: { 'x-api-key': 'mine' },
    auth: { type: 'header', name: 'X-Api-Key', value: 'secret-1' },
  })
  const headers = explicit.init.headers as Record<string, string>
  assert.equal(headers['x-api-key'], 'mine')
  assert.equal(headers['X-Api-Key'], undefined)
})

test('auth type query appends a query parameter', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com/things?a=1',
    auth: { type: 'query', name: 'api_key', value: 'secret-2' },
  })
  assert.equal(request.url, 'https://api.example.com/things?a=1&api_key=secret-2')
})

test('redactHttpStepInput redacts auth option secrets but keeps its shape', () => {
  const redacted = redactHttpStepInput({
    url: 'https://api.example.com',
    auth: { type: 'basic', username: 'user', password: 'pass' },
  })
  assert.deepEqual(redacted.auth, { type: 'basic', username: 'user', password: 'redacted' })

  const query = redactHttpStepInput({
    url: 'https://api.example.com',
    auth: { type: 'query', name: 'api_key', value: 'secret' },
  })
  assert.deepEqual(query.auth, { type: 'query', name: 'api_key', value: 'redacted' })

  const bearer = redactHttpStepInput({
    url: 'https://api.example.com',
    auth: { type: 'bearer', token: 'tok' },
  })
  assert.deepEqual(bearer.auth, { type: 'bearer', token: 'redacted' })
})

test('withBearerAuthorization injects a bearer token when no auth header is set', () => {
  const headers = { 'content-type': 'application/json' }
  const next = withBearerAuthorization(headers, 'tok-123')
  assert.deepEqual(next, { 'content-type': 'application/json', authorization: 'Bearer tok-123' })
  // Input is not mutated
  assert.deepEqual(headers, { 'content-type': 'application/json' })
})

test('withBearerAuthorization never overrides an explicit Authorization header', () => {
  assert.deepEqual(
    withBearerAuthorization({ authorization: 'Bearer mine' }, 'tok-123'),
    { authorization: 'Bearer mine' },
  )
  // Case-insensitive: any casing of the user's header wins
  assert.deepEqual(
    withBearerAuthorization({ Authorization: 'Basic abc' }, 'tok-123'),
    { Authorization: 'Basic abc' },
  )
  assert.deepEqual(
    withBearerAuthorization({ 'Proxy-Authorization': 'Basic abc' }, 'tok-123'),
    { 'Proxy-Authorization': 'Basic abc' },
  )
  // Header names with surrounding whitespace still count as explicit
  assert.deepEqual(
    withBearerAuthorization({ ' authorization': 'Bearer mine' }, 'tok-123'),
    { ' authorization': 'Bearer mine' },
  )
})

test('withBearerAuthorization treats empty Authorization values as absent', () => {
  // A template that resolved to an empty string must not block injection or
  // leave a blank credential on the request
  assert.deepEqual(
    withBearerAuthorization({ Authorization: '', 'x-id': 'a' }, 'tok-123'),
    { 'x-id': 'a', authorization: 'Bearer tok-123' },
  )
  assert.deepEqual(
    withBearerAuthorization({ authorization: '   ' }, 'tok-123'),
    { authorization: 'Bearer tok-123' },
  )
})

test('redactAuthHeaders replaces auth header values in objects, any casing', () => {
  assert.deepEqual(
    redactAuthHeaders({ Authorization: 'Bearer secret', 'x-count': 5 }),
    { Authorization: 'redacted', 'x-count': 5 },
  )
  assert.deepEqual(
    redactAuthHeaders({ authorization: 'Basic secret', 'proxy-authorization': 'secret' }),
    { authorization: 'redacted', 'proxy-authorization': 'redacted' },
  )
  // Key trimming is symmetric with injection precedence; empty values still redact
  assert.deepEqual(
    redactAuthHeaders({ ' Authorization ': 'Bearer secret', authorization: '' }),
    { ' Authorization ': 'redacted', authorization: 'redacted' },
  )
})

test('redactAuthHeaders handles JSON strings and non-JSON strings', () => {
  assert.equal(
    redactAuthHeaders('{"authorization":"Bearer secret","x-id":"1"}'),
    '{"authorization":"redacted","x-id":"1"}',
  )
  // Non-JSON string that mentions an auth header: drop it entirely
  assert.equal(redactAuthHeaders('Authorization: Bearer secret'), 'redacted')
  // Harmless strings and non-header values pass through
  assert.equal(redactAuthHeaders('x-count: 5'), 'x-count: 5')
  assert.equal(redactAuthHeaders(undefined), undefined)
})

test('redactHttpStepInput redacts only the headers field and keeps the rest', () => {
  const config = {
    method: 'POST',
    url: 'https://api.example.com',
    headers: { authorization: 'Bearer secret', 'x-id': 'a' },
    body: '{"ok":true}',
    connectionId: 'conn-1',
  }
  const safe = redactHttpStepInput(config)
  assert.deepEqual(safe.headers, { authorization: 'redacted', 'x-id': 'a' })
  assert.equal(safe.url, 'https://api.example.com')
  assert.equal(safe.body, '{"ok":true}')
  assert.equal(safe.connectionId, 'conn-1')
  // Original config untouched
  assert.deepEqual(config.headers, { authorization: 'Bearer secret', 'x-id': 'a' })
  // No headers set: config passes through unchanged
  const bare = { method: 'GET', url: 'https://api.example.com' }
  assert.deepEqual(redactHttpStepInput(bare), bare)
})

test('responseOutput auto-parses JSON responses and keeps raw body text', async () => {
  const response = new Response('{"ok":true}', {
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json' },
  })
  const output = await responseOutput(response, 'auto')
  assert.equal(output.ok, true)
  assert.equal(output.status, 201)
  assert.deepEqual(output.body, { ok: true })
  assert.equal(output.bodyText, '{"ok":true}')
})

test('responseOutput can force text or JSON parsing', async () => {
  const text = await responseOutput(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }), 'text')
  assert.equal(text.body, '{"ok":true}')
  await assert.rejects(() => responseOutput(new Response('not-json'), 'json'), /not valid JSON/)
})
