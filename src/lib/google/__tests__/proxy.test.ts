import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __testHooks, clearGoogleTokenCache, googleProxy, isGoogleNativeProvider } from '../proxy'

const CONN = { organizationId: 'o1', connectionId: 'c1' }
const RECORD = { id: 'c1', organizationId: 'o1', service: 'google-mail', refreshToken: 'rt', status: 'connected' }

beforeEach(() => {
  clearGoogleTokenCache()
  __testHooks.reset()
})

test('provider discriminator', () => {
  assert.equal(isGoogleNativeProvider('google-native'), true)
  assert.equal(isGoogleNativeProvider('google'), false)
  assert.equal(isGoogleNativeProvider(null), false)
})

test('maps gmail endpoints to gmail.googleapis.com and sends bearer', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  __testHooks.set({
    loadConnection: async () => RECORD,
    refresh: async () => ({ accessToken: 'at-1', expiresIn: 3600 }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const proxy = googleProxy(CONN)
  const result = await proxy({ method: 'POST', endpoint: '/gmail/v1/users/me/messages/send', connectionId: 'c1', providerConfigKey: 'google-mail', data: { raw: 'x' } })
  assert.deepEqual(result.data, { ok: true })
  assert.equal(calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer at-1')
})

test('retries exactly once on 401 with a forced refresh', async () => {
  let refreshes = 0
  let attempts = 0
  __testHooks.set({
    loadConnection: async () => RECORD,
    refresh: async () => ({ accessToken: `at-${++refreshes}`, expiresIn: 3600 }),
    fetchImpl: async () => {
      attempts += 1
      return attempts === 1
        ? new Response('unauthorized', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const proxy = googleProxy(CONN)
  const result = await proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/profile', connectionId: 'c1', providerConfigKey: 'google-mail' })
  assert.deepEqual(result.data, { ok: true })
  assert.equal(attempts, 2)
  assert.equal(refreshes, 2)
})

test('reuses a cached access token across calls', async () => {
  let refreshes = 0
  __testHooks.set({
    loadConnection: async () => RECORD,
    refresh: async () => ({ accessToken: `at-${++refreshes}`, expiresIn: 3600 }),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })
  const proxy = googleProxy(CONN)
  await proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/profile', connectionId: 'c1', providerConfigKey: 'google-mail' })
  await proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/profile', connectionId: 'c1', providerConfigKey: 'google-mail' })
  assert.equal(refreshes, 1)
})

test('refresh failure marks the connection errored and rethrows', async () => {
  const marked: string[] = []
  __testHooks.set({
    loadConnection: async () => RECORD,
    refresh: async () => {
      throw new Error('invalid_grant')
    },
    fetchImpl: async () => new Response('{}', { status: 200 }),
    markError: async (_input, message) => {
      marked.push(message)
    },
  })
  const proxy = googleProxy(CONN)
  await assert.rejects(
    () => proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/profile', connectionId: 'c1', providerConfigKey: 'google-mail' }),
    /invalid_grant/,
  )
  assert.equal(marked.length, 1)
})
