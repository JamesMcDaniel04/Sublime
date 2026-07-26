import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { performHttpRequest, prepareHttpRequest, responseOutput, withBearerAuthorization, redactAuthHeaders, redactHttpStepInput, oauth1SignatureBase } from '../http'

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

test('send toggles suppress stored query, headers, and body without deleting them', () => {
  const request = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/items',
    query: '{"page":2}',
    headers: '{"x-api-key":"keep-for-later"}',
    body: '{"name":"saved"}',
    bodyMode: 'json',
    sendQuery: false,
    sendHeaders: false,
    sendBody: false,
  })
  assert.equal(request.url, 'https://api.example.com/items')
  assert.deepEqual(request.init.headers, {})
  assert.equal(request.init.body, undefined)
})

test('GraphQL mode serializes query and variables as JSON', () => {
  const request = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/graphql',
    bodyMode: 'graphql',
    body: 'query Thing($id: ID!) { thing(id: $id) { name } }',
    graphqlVariables: '{"id":"thing_1"}',
  })
  assert.equal(request.init.body, JSON.stringify({
    query: 'query Thing($id: ID!) { thing(id: $id) { name } }',
    variables: { id: 'thing_1' },
  }))
  assert.equal((request.init.headers as Record<string, string>)['content-type'], 'application/json')
})

test('raw mode sends its explicit content type', () => {
  const request = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/document',
    bodyMode: 'raw',
    bodyContentType: 'text/html',
    body: '<p>Hello</p>',
  })
  assert.equal(request.init.body, '<p>Hello</p>')
  assert.equal((request.init.headers as Record<string, string>)['content-type'], 'text/html')
})

test('OAuth1 runtime auth signs the actual request URL', async () => {
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/items?page=2' })
  request.runtimeAuth = {
    type: 'oauth1',
    consumerKey: 'consumer',
    consumerSecret: 'consumer-secret',
    accessToken: 'token',
    tokenSecret: 'token-secret',
    signatureMethod: 'HMAC-SHA256',
  }
  let authorization = ''
  await performHttpRequest(request, {}, {
    fetchImpl: (async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  assert.match(authorization, /^OAuth /)
  assert.match(authorization, /oauth_signature_method="HMAC-SHA256"/)
  assert.match(authorization, /oauth_signature=/)
  assert.equal(authorization.includes('consumer-secret'), false)
})

test('Digest runtime auth answers a server challenge and retries once', async () => {
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/protected' })
  request.runtimeAuth = { type: 'digest', username: 'joe', password: 'secret' }
  const authorizations: string[] = []
  await performHttpRequest(request, {}, {
    fetchImpl: (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      authorizations.push(authorization)
      if (!authorization) {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Digest realm="api", nonce="abc", qop="auth", algorithm=SHA-256' },
        })
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  assert.equal(authorizations.length, 2)
  assert.match(authorizations[1], /^Digest /)
  assert.match(authorizations[1], /username="joe"/)
  assert.equal(authorizations[1].includes('secret'), false)
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

// ── Body / method parity (n8n sends a body on any method fetch permits) ──────

test('a body on DELETE and OPTIONS is sent, not dropped', () => {
  for (const method of ['DELETE', 'OPTIONS']) {
    const request = prepareHttpRequest({
      method, url: 'https://api.example.com/x', sendBody: true, bodyMode: 'json', body: '{"a":1}',
    })
    assert.equal(request.init.body, '{"a":1}', `${method} should carry a body`)
  }
})

test('an explicit body on GET fails loudly instead of being dropped', () => {
  assert.throws(
    () => prepareHttpRequest({
      method: 'GET', url: 'https://api.example.com/x', sendBody: true, bodyMode: 'json', body: '{"a":1}',
    }),
    /GET requests cannot send a body/,
  )
})

test('a GraphQL body on GET fails loudly rather than sending an empty request', () => {
  assert.throws(
    () => prepareHttpRequest({
      method: 'GET', url: 'https://api.example.com/gql', sendBody: true, bodyMode: 'graphql', body: '{ me { id } }',
    }),
    /GET requests cannot send a body/,
  )
})

test('a leftover body from a method switch is dropped silently when Send Body is off', () => {
  const request = prepareHttpRequest({
    method: 'GET', url: 'https://api.example.com/x', sendBody: false, bodyMode: 'json', body: '{"a":1}',
  })
  assert.equal(request.init.body, undefined)
})

test('a raw body defaults to text/plain rather than sending no Content-Type', () => {
  const request = prepareHttpRequest({
    method: 'POST', url: 'https://api.example.com/x', sendBody: true, bodyMode: 'raw', body: '<xml/>',
  })
  assert.equal((request.init.headers as Record<string, string>)['content-type'], 'text/plain')
})

test('an explicit raw Content-Type still wins over the default', () => {
  const request = prepareHttpRequest({
    method: 'POST', url: 'https://api.example.com/x', sendBody: true, bodyMode: 'raw',
    bodyContentType: 'application/xml', body: '<xml/>',
  })
  assert.equal((request.init.headers as Record<string, string>)['content-type'], 'application/xml')
})

// ── URL errors name the field instead of surfacing a bare TypeError ──────────

test('an empty URL with query params names the URL field', () => {
  assert.throws(
    () => prepareHttpRequest({ method: 'GET', url: '', sendQuery: true, query: '{"a":"1"}' }),
    /URL is required/,
  )
})

test('a schemeless URL says so instead of throwing a bare Invalid URL', () => {
  assert.throws(
    () => prepareHttpRequest({ method: 'GET', url: 'api.example.com/x', sendQuery: true, query: '{"a":"1"}' }),
    /is not a valid URL.*https:\/\//s,
  )
})

// ── OAuth1 signature base string (RFC 5849 §3.4.1.1) ────────────────────────
// Signing only the query params produces valid-looking but rejected signatures
// on POST form requests, which is most of the OAuth1 API surface in the wild.

test('the OAuth1 signature base string matches the RFC 5849 worked example', () => {
  const base = oauth1SignatureBase(
    'POST',
    'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
    {
      oauth_consumer_key: '9djdj82h48djs9d2',
      oauth_token: 'kkk9d7dh3k39sjv7',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '137131201',
      oauth_nonce: '7d8f3e4a',
    },
    [['c2', ''], ['a3', '2 q']],
  )
  assert.equal(
    base,
    'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D'
      + '%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a'
      + '%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7',
  )
})

test('a signed OAuth1 form request includes its body params in the signature', async () => {
  // The nonce is random, so comparing two signatures proves nothing. Instead
  // recompute the signature from the header the code actually sent, using a
  // base string that DOES include the body — it can only match if the
  // implementation included the body too.
  let sent = ''
  const request = prepareHttpRequest({
    method: 'POST', url: 'https://api.example.com/statuses?include=1', sendBody: true,
    bodyMode: 'formUrlencoded', body: '{"status":"hello world","trim":"1"}',
  })
  request.runtimeAuth = {
    type: 'oauth1', consumerKey: 'ck', consumerSecret: 'cs',
    accessToken: 'at', tokenSecret: 'ts', signatureMethod: 'HMAC-SHA1',
  }
  await performHttpRequest(request, {}, {
    fetchImpl: async (_url, init) => {
      sent = new Headers((init as RequestInit).headers).get('authorization') ?? ''
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const fields = [...sent.matchAll(/(\w+)="([^"]*)"/g)]
    .map(([, key, value]) => [key, decodeURIComponent(value)] as const)
  const signature = fields.find(([key]) => key === 'oauth_signature')?.[1]
  const oauthParams = Object.fromEntries(fields.filter(([key]) => key !== 'oauth_signature'))
  const expected = createHmac('sha1', 'cs&ts')
    .update(oauth1SignatureBase(
      'POST',
      'https://api.example.com/statuses?include=1',
      oauthParams,
      [['status', 'hello world'], ['trim', '1']],
    ))
    .digest('base64')

  assert.ok(signature, 'the request should carry an oauth_signature')
  assert.equal(signature, expected)
})

test('a digest challenge round-trip counts both fetches against batch throttling', async () => {
  // Digest sends an unauthenticated probe, reads the challenge, then sends the
  // real request — two calls on the wire. A batch throttle exists to respect a
  // remote rate limit, so counting the pair as one request sends twice the
  // traffic the user asked for between pauses.
  let fetches = 0
  let sleeps = 0
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/items' })
  request.runtimeAuth = { type: 'digest', username: 'u', password: 'p' }

  await performHttpRequest(
    request,
    { pagination: { mode: 'page', maxPages: 3 }, batch: { size: 2, delayMs: 5 } },
    {
      sleep: async () => { sleeps += 1 },
      fetchImpl: async (_url, init) => {
        fetches += 1
        if (!new Headers((init as RequestInit).headers).has('authorization')) {
          return new Response('', { status: 401, headers: { 'www-authenticate': 'Digest realm="r", nonce="n", qop="auth"' } })
        }
        return new Response('[{"id":1}]', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    },
  )

  assert.equal(fetches, 6, 'three pages of a challenge + authenticated pair')
  assert.equal(sleeps, 2, 'a batch of 2 should pause before pages 2 and 3')
})

// ── WS1 hardening probes: every method actually callable ────────────────────

test('every HTTP method reaches the wire with its body where permitted', async () => {
  const cases: Array<{ method: string; expectBody: boolean }> = [
    { method: 'GET', expectBody: false },
    { method: 'HEAD', expectBody: false },
    { method: 'POST', expectBody: true },
    { method: 'PUT', expectBody: true },
    { method: 'PATCH', expectBody: true },
    { method: 'DELETE', expectBody: true },
    { method: 'OPTIONS', expectBody: true },
  ]
  for (const { method, expectBody } of cases) {
    const request = prepareHttpRequest({
      method,
      url: 'https://api.example.com/things',
      // GET/HEAD leave Send Body off, as the editor does for a body-less method.
      ...(expectBody ? { sendBody: true, bodyMode: 'json' as const, body: '{"a":1}' } : {}),
      query: '{"q":"x"}',
      headers: '{"x-probe":"1"}',
    })
    let seenMethod = ''
    let seenBody: unknown
    let seenHeader = ''
    const output = await performHttpRequest(request, {}, {
      fetchImpl: (async (url, init) => {
        seenMethod = String(init?.method)
        seenBody = init?.body
        seenHeader = new Headers(init?.headers).get('x-probe') ?? ''
        // HEAD responses have no body, like the real network.
        return new Response(method === 'HEAD' ? null : '{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    assert.equal(seenMethod, method)
    assert.equal(seenHeader, '1', `${method} carries headers`)
    assert.equal(request.url.includes('q=x'), true, `${method} carries query params`)
    if (expectBody) assert.equal(seenBody, '{"a":1}', `${method} carries its body`)
    else assert.equal(seenBody, undefined, `${method} sends no body`)
    assert.equal('status' in output && output.status, 200, `${method} parses its response`)
  }
})
