/**
 * OAuth2 client-credentials token exchange and its cache.
 *
 * The cache is not an optimisation detail: without it every HTTP step (and
 * every pagination page) mints a fresh token, which burns provider rate limits
 * and adds a round-trip to each request. The invariant that matters is that an
 * edited credential never keeps serving a token minted from the old secret.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { invalidateOAuth2Token, oauth2ClientCredentialPlan, resetOAuth2TokenCache } from '../oauth2'

const credential = {
  type: 'oauth2' as const,
  grantType: 'clientCredentials' as const,
  tokenUrl: 'https://auth.example.com/token',
  clientId: 'client',
  clientSecret: 'secret',
}

const tokenServer = (token: string, expiresIn: number | null) => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return new Response(
      JSON.stringify({ access_token: `${token}-${calls}`, token_type: 'Bearer', ...(expiresIn === null ? {} : { expires_in: expiresIn }) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { fetchImpl, calls: () => calls }
}

beforeEach(() => resetOAuth2TokenCache())

test('a second request reuses the cached token instead of minting a new one', async () => {
  const server = tokenServer('tok', 3600)
  const first = await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })
  const second = await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })

  assert.equal(server.calls(), 1)
  assert.deepEqual(first.headers, { authorization: 'Bearer tok-1' })
  assert.deepEqual(second.headers, { authorization: 'Bearer tok-1' })
})

test('a different credential never shares a cached token', async () => {
  const server = tokenServer('tok', 3600)
  await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })
  const other = await oauth2ClientCredentialPlan('cred_2', credential, { fetchImpl: server.fetchImpl })

  assert.equal(server.calls(), 2)
  assert.deepEqual(other.headers, { authorization: 'Bearer tok-2' })
})

test('a token near its expiry is re-minted rather than served stale', async () => {
  // Well inside the safety margin, so it counts as already expired.
  const server = tokenServer('tok', 5)
  await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })
  await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })

  assert.equal(server.calls(), 2)
})

test('a token with no stated lifetime is never cached', async () => {
  const server = tokenServer('tok', null)
  await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })
  await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })

  assert.equal(server.calls(), 2)
})

test('editing a credential invalidates its cached token', async () => {
  const server = tokenServer('tok', 3600)
  await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })
  invalidateOAuth2Token('cred_1')
  const after = await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })

  assert.equal(server.calls(), 2)
  assert.deepEqual(after.headers, { authorization: 'Bearer tok-2' })
})

test('rotating the client secret is not served from cache', async () => {
  const server = tokenServer('tok', 3600)
  await oauth2ClientCredentialPlan('cred_1', credential, { fetchImpl: server.fetchImpl })
  await oauth2ClientCredentialPlan('cred_1', { ...credential, clientSecret: 'rotated' }, { fetchImpl: server.fetchImpl })

  assert.equal(server.calls(), 2)
})

test('the token endpoint is checked against the SSRF guard before it is called', async () => {
  const server = tokenServer('tok', 3600)
  const seen: string[] = []
  await oauth2ClientCredentialPlan('cred_1', credential, {
    fetchImpl: server.fetchImpl,
    assertUrlAllowed: async (url) => { seen.push(url) },
  })
  assert.deepEqual(seen, ['https://auth.example.com/token'])
})

test('an incomplete credential explains what is missing', async () => {
  await assert.rejects(
    () => oauth2ClientCredentialPlan('cred_1', { ...credential, tokenUrl: '' }, { fetchImpl: tokenServer('t', 60).fetchImpl }),
    /incomplete/,
  )
})
