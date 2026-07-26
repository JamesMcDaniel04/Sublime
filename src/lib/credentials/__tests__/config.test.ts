/**
 * Credential config round-trips. The invariant under test is one-directional:
 * a secret goes in plaintext, is stored encrypted, comes back out of the
 * REDACTED view as a boolean only, and is recoverable ONLY through the explicit
 * decrypt path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

async function fresh() {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  return import(`../config?t=${Date.now()}-${Math.random()}`) as Promise<typeof import('../config')>
}

test('bearer: token is encrypted, redaction hides it, decrypt round-trips', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'bearer', token: 'sk-abc' })
  assert.notEqual(cfg.token, 'sk-abc')
  const red = redactCredential('bearer', cfg)
  assert.deepEqual(red, { type: 'bearer', hasToken: true })
  assert.equal(JSON.stringify(red).includes('sk-abc'), false)
  assert.equal(decryptCredentialConfig('bearer', cfg).token, 'sk-abc')
})

test('private CA trust material is encrypted and never returned by redaction', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'bearer', token: 'postgres://db', caCert: 'PRIVATE CA' })
  assert.notEqual(cfg.caCert, 'PRIVATE CA')
  assert.deepEqual(redactCredential('bearer', cfg), {
    type: 'bearer',
    hasToken: true,
    hasCaCert: true,
  })
  assert.equal(decryptCredentialConfig('bearer', cfg).caCert, 'PRIVATE CA')
})

test('basic: username plaintext, password encrypted', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'basic', username: 'joe', password: 'pw' })
  assert.equal(cfg.username, 'joe')
  assert.notEqual(cfg.password, 'pw')
  assert.deepEqual(redactCredential('basic', cfg), { type: 'basic', username: 'joe', hasPassword: true })
  assert.equal(decryptCredentialConfig('basic', cfg).password, 'pw')
})

test('apiKeyHeader: headerName plaintext, key encrypted', async () => {
  const { buildCredentialConfig, redactCredential } = await fresh()
  const cfg = buildCredentialConfig({ type: 'apiKeyHeader', headerName: 'X-API-Key', key: 'secret' })
  assert.equal(cfg.headerName, 'X-API-Key')
  assert.notEqual(cfg.key, 'secret')
  assert.deepEqual(redactCredential('apiKeyHeader', cfg), { type: 'apiKeyHeader', headerName: 'X-API-Key', hasKey: true })
})

test('apiKeyQuery: queryParam plaintext, key encrypted', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'apiKeyQuery', queryParam: 'api_key', key: 'secret' })
  assert.equal(cfg.queryParam, 'api_key')
  assert.notEqual(cfg.key, 'secret')
  assert.deepEqual(redactCredential('apiKeyQuery', cfg), { type: 'apiKeyQuery', queryParam: 'api_key', hasKey: true })
  assert.equal(decryptCredentialConfig('apiKeyQuery', cfg).key, 'secret')
})

test('custom: each header value encrypted, redaction lists names only', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'custom', headers: [{ name: 'X-A', value: 'a' }], query: [{ name: 'q', value: 'b' }] })
  const dec = decryptCredentialConfig('custom', cfg)
  assert.deepEqual(dec.headers, [{ name: 'X-A', value: 'a' }])
  assert.deepEqual(dec.query, [{ name: 'q', value: 'b' }])
  const red = redactCredential('custom', cfg)
  assert.deepEqual(red.headers, [{ name: 'X-A', hasValue: true }])
  assert.equal(JSON.stringify(red).includes('"a"'), false)
})

test('custom drops entries with a blank name', async () => {
  // A blank row is the editor's "add another" affordance, not a credential.
  const { buildCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'custom', headers: [{ name: '  ', value: 'x' }, { name: 'X-B', value: 'y' }] })
  assert.equal((cfg.headers as unknown[]).length, 1)
})

test('merge preserves an omitted secret but updates metadata', async () => {
  const { buildCredentialConfig, mergeCredentialConfig, decryptCredentialConfig } = await fresh()
  const existing = buildCredentialConfig({ type: 'apiKeyHeader', headerName: 'X-Old', key: 'keep' })
  const merged = mergeCredentialConfig(existing, { type: 'apiKeyHeader', headerName: 'X-New' })
  assert.equal(merged.headerName, 'X-New')
  assert.equal(decryptCredentialConfig('apiKeyHeader', merged).key, 'keep')
})

test('merge replaces a secret when a new one IS supplied', async () => {
  const { buildCredentialConfig, mergeCredentialConfig, decryptCredentialConfig } = await fresh()
  const existing = buildCredentialConfig({ type: 'bearer', token: 'old' })
  const merged = mergeCredentialConfig(existing, { type: 'bearer', token: 'new' })
  assert.equal(decryptCredentialConfig('bearer', merged).token, 'new')
})

test('redaction of an unknown type still reveals nothing', async () => {
  // Defensive: a row whose type predates a rename must not spill its config.
  const { redactCredential } = await fresh()
  const red = redactCredential('somethingElse', { token: 'v1:AAA:BBB:CCC', key: 'raw' })
  assert.equal(JSON.stringify(red).includes('AAA'), false)
  assert.equal(JSON.stringify(red).includes('raw'), false)
})

test('an empty authConfig redacts to hasX=false rather than throwing', async () => {
  const { redactCredential } = await fresh()
  assert.deepEqual(redactCredential('bearer', {}), { type: 'bearer', hasToken: false })
  assert.deepEqual(redactCredential('bearer', null), { type: 'bearer', hasToken: false })
})

test('OAuth1 encrypts every secret while preserving signing metadata', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({
    type: 'oauth1',
    consumerKey: 'consumer',
    consumerSecret: 'consumer-secret',
    accessToken: 'access',
    tokenSecret: 'token-secret',
    signatureMethod: 'HMAC-SHA256',
  })
  assert.equal(cfg.consumerKey, 'consumer')
  assert.notEqual(cfg.consumerSecret, 'consumer-secret')
  assert.notEqual(cfg.accessToken, 'access')
  assert.deepEqual(redactCredential('oauth1', cfg), {
    type: 'oauth1',
    consumerKey: 'consumer',
    hasConsumerSecret: true,
    hasAccessToken: true,
    hasTokenSecret: true,
    signatureMethod: 'HMAC-SHA256',
  })
  assert.equal(decryptCredentialConfig('oauth1', cfg).tokenSecret, 'token-secret')
})

test('OAuth2 client credentials redact secrets and keep endpoint metadata', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({
    type: 'oauth2',
    grantType: 'clientCredentials',
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client',
    clientSecret: 'client-secret',
    scope: 'read write',
    clientAuth: 'header',
  })
  assert.notEqual(cfg.clientSecret, 'client-secret')
  assert.deepEqual(redactCredential('oauth2', cfg), {
    type: 'oauth2',
    grantType: 'clientCredentials',
    hasAccessToken: false,
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client',
    hasClientSecret: true,
    scope: 'read write',
    clientAuth: 'header',
  })
  assert.equal(decryptCredentialConfig('oauth2', cfg).clientSecret, 'client-secret')
})

// ── Custom entries: the input list is authoritative on update ───────────────

test('renaming a custom entry keeps the stored secret attached', async () => {
  const { buildCredentialConfig, mergeCredentialConfig, decryptCredentialConfig } = await fresh()
  const stored = buildCredentialConfig({
    type: 'custom',
    headers: [{ name: 'X-Old', value: 'super-secret' }],
  })
  const merged = mergeCredentialConfig(stored, {
    type: 'custom',
    headers: [{ name: 'X-Renamed', originalName: 'X-Old' }],
  })
  assert.deepEqual(decryptCredentialConfig('custom', merged).headers, [
    { name: 'X-Renamed', value: 'super-secret' },
  ])
})

test('an entry left out of the update is removed', async () => {
  const { buildCredentialConfig, mergeCredentialConfig, decryptCredentialConfig } = await fresh()
  const stored = buildCredentialConfig({
    type: 'custom',
    headers: [{ name: 'X-Keep', value: 'a' }, { name: 'X-Drop', value: 'b' }],
  })
  const merged = mergeCredentialConfig(stored, {
    type: 'custom',
    headers: [{ name: 'X-Keep', originalName: 'X-Keep' }],
  })
  assert.deepEqual(decryptCredentialConfig('custom', merged).headers, [{ name: 'X-Keep', value: 'a' }])
})

test('a re-typed custom value replaces the stored one', async () => {
  const { buildCredentialConfig, mergeCredentialConfig, decryptCredentialConfig } = await fresh()
  const stored = buildCredentialConfig({ type: 'custom', headers: [{ name: 'X-Key', value: 'old' }] })
  const merged = mergeCredentialConfig(stored, {
    type: 'custom',
    headers: [{ name: 'X-Key', value: 'new', originalName: 'X-Key' }],
  })
  assert.deepEqual(decryptCredentialConfig('custom', merged).headers, [{ name: 'X-Key', value: 'new' }])
})

test('a new entry with no value is not stored as a blank secret', async () => {
  const { buildCredentialConfig, decryptCredentialConfig } = await fresh()
  const config = buildCredentialConfig({
    type: 'custom',
    headers: [{ name: 'X-Filled', value: 'a' }, { name: 'X-Empty' }],
  })
  assert.deepEqual(decryptCredentialConfig('custom', config).headers, [{ name: 'X-Filled', value: 'a' }])
})

test('omitting the entry lists entirely leaves the stored ones alone', async () => {
  const { buildCredentialConfig, mergeCredentialConfig, decryptCredentialConfig } = await fresh()
  const stored = buildCredentialConfig({ type: 'custom', headers: [{ name: 'X-Key', value: 'a' }] })
  const merged = mergeCredentialConfig(stored, { type: 'custom' })
  assert.deepEqual(decryptCredentialConfig('custom', merged).headers, [{ name: 'X-Key', value: 'a' }])
})
