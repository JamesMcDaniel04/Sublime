/**
 * External secret providers.
 *
 * The credential vault is good — placeholder-only reveal, rotation, lifecycle
 * audit — and it is the wrong shape for an org that already runs HashiCorp
 * Vault or 1Password. Those workspaces cannot point Sublime at the store they
 * already operate, which for a larger org is a procurement blocker rather than
 * a convenience.
 *
 * Three providers need no new dependency because they are HTTP APIs with a
 * token header: HashiCorp Vault, Infisical, and 1Password Connect. AWS, Azure
 * and GCP need request signing or an OAuth exchange and are deliberately out
 * of scope here rather than half-implemented.
 *
 * The dangerous half is not fetching — it is making sure a resolved secret
 * never lands anywhere it can be read back. Hence `redactSecrets`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSecretProviders, parseSecretRef, redactSecrets, SECRETS_ROOT } from '../providers'

const env = (over: Record<string, string | undefined> = {}) => ({ ...over })

// ── configuring a provider ──────────────────────────────────────────────────

test('no provider is configured by default', () => {
  assert.deepEqual(resolveSecretProviders({}), [])
})

test('a Vault provider is registered from the environment', () => {
  const providers = resolveSecretProviders(env({
    SECRETS_PROVIDER_VAULT_KIND: 'vault',
    SECRETS_PROVIDER_VAULT_BASE_URL: 'https://vault.internal:8200',
    SECRETS_PROVIDER_VAULT_TOKEN: 'hvs.x',
  }))
  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'vault')
  assert.equal(providers[0].kind, 'vault')
})

test('several providers can coexist', () => {
  const providers = resolveSecretProviders(env({
    SECRETS_PROVIDER_VAULT_KIND: 'vault', SECRETS_PROVIDER_VAULT_BASE_URL: 'https://a', SECRETS_PROVIDER_VAULT_TOKEN: 't1',
    SECRETS_PROVIDER_OP_KIND: 'onepassword', SECRETS_PROVIDER_OP_BASE_URL: 'https://b', SECRETS_PROVIDER_OP_TOKEN: 't2',
  }))
  assert.deepEqual(providers.map((p) => p.id).sort(), ['op', 'vault'])
})

test('a provider missing its token is not registered', () => {
  const providers = resolveSecretProviders(env({
    SECRETS_PROVIDER_VAULT_KIND: 'vault', SECRETS_PROVIDER_VAULT_BASE_URL: 'https://a',
  }))
  assert.deepEqual(providers, [])
})

// A secret store reached over plaintext would put the store's own token, and
// every secret it returns, on the wire in the clear. Loopback is exempted for
// a local dev Vault and nothing else.
test('a plaintext endpoint is refused unless it is loopback', () => {
  const remote = resolveSecretProviders(env({
    SECRETS_PROVIDER_V_KIND: 'vault', SECRETS_PROVIDER_V_BASE_URL: 'http://vault.example.com', SECRETS_PROVIDER_V_TOKEN: 't',
  }))
  assert.deepEqual(remote, [], 'plaintext to a remote secret store must be refused')

  const local = resolveSecretProviders(env({
    SECRETS_PROVIDER_V_KIND: 'vault', SECRETS_PROVIDER_V_BASE_URL: 'http://127.0.0.1:8200', SECRETS_PROVIDER_V_TOKEN: 't',
  }))
  assert.equal(local.length, 1)
})

test('an unknown provider kind is refused rather than guessed', () => {
  const providers = resolveSecretProviders(env({
    SECRETS_PROVIDER_X_KIND: 'mystery', SECRETS_PROVIDER_X_BASE_URL: 'https://a', SECRETS_PROVIDER_X_TOKEN: 't',
  }))
  assert.deepEqual(providers, [])
})

// ── parsing a reference ─────────────────────────────────────────────────────

test('a reference names a provider and a path', () => {
  assert.deepEqual(parseSecretRef('secrets.vault.stripe_key'), { provider: 'vault', path: 'stripe_key' })
})

test('a path may contain slashes, as secret stores do', () => {
  assert.deepEqual(parseSecretRef('secrets.vault.kv/data/prod/stripe'), { provider: 'vault', path: 'kv/data/prod/stripe' })
})

test('a non-secrets path is not claimed', () => {
  assert.equal(parseSecretRef('workspace.channel'), null)
  assert.equal(parseSecretRef('trigger.input'), null)
})

// The bare root would resolve to "every secret", which is never what anyone
// means and is a disclosure if a template renders it.
test('the bare root resolves to nothing', () => {
  assert.equal(parseSecretRef('secrets'), null)
})

test('a reference with no path is refused', () => {
  assert.equal(parseSecretRef('secrets.vault'), null)
})

test('SECRETS_ROOT is what the resolver dispatches on', () => {
  assert.equal(SECRETS_ROOT, 'secrets')
})

// ── redaction ───────────────────────────────────────────────────────────────
//
// The part that makes this safe. A resolved secret is a real value flowing
// through step outputs, run rows and error messages; without scrubbing it on
// the way out, using a secret store is WORSE than the vault, because the vault
// never hands the value to the graph at all.

test('a resolved secret is scrubbed from a string', () => {
  assert.equal(redactSecrets('token=sk-live-abc123', ['sk-live-abc123']), 'token=redacted')
})

test('every occurrence is scrubbed, not just the first', () => {
  const out = redactSecrets('a=S3CRET b=S3CRET', ['S3CRET']) as string
  assert.doesNotMatch(out, /S3CRET/)
})

test('secrets are scrubbed from nested structures', () => {
  const out = redactSecrets({ headers: { auth: 'Bearer S3CRET' }, list: ['S3CRET'] }, ['S3CRET'])
  assert.doesNotMatch(JSON.stringify(out), /S3CRET/)
})

// A short or empty secret would match everywhere and turn the whole output
// into "redacted".
test('trivial values are not used as scrub patterns', () => {
  assert.equal(redactSecrets('a normal sentence', ['', ' ', 'a']), 'a normal sentence')
})

test('nothing to redact returns the value unchanged', () => {
  const value = { a: 1, b: 'two' }
  assert.deepEqual(redactSecrets(value, []), value)
})

// ── path safety ─────────────────────────────────────────────────────────────
//
// The base URL is operator configuration; the PATH comes from a flow template.
// So the path is the attack surface, and these are the shapes that would let
// it leave the configured store — taking the store's token with it.

test('a path containing a URL is refused', async () => {
  const { assertSafeSecretPath } = await import('../providers')
  assert.throws(() => assertSafeSecretPath('https://attacker.example/steal'), /URL/i)
  assert.throws(() => assertSafeSecretPath('//attacker.example/steal'), /URL/i)
})

test('a path climbing out of the store prefix is refused', async () => {
  const { assertSafeSecretPath } = await import('../providers')
  assert.throws(() => assertSafeSecretPath('kv/../../admin'), /\.\./)
})

test('an ordinary nested path is allowed', async () => {
  const { assertSafeSecretPath } = await import('../providers')
  assert.doesNotThrow(() => assertSafeSecretPath('kv/data/prod/stripe'))
})

// A dot inside a segment is a normal secret name, not traversal.
test('a dotted segment is not mistaken for traversal', async () => {
  const { assertSafeSecretPath } = await import('../providers')
  assert.doesNotThrow(() => assertSafeSecretPath('kv/data/my.service.key'))
})

// ── collecting references from a graph ──────────────────────────────────────
//
// Scanning the serialized graph rather than walking known config fields: a
// token can appear in any string a node author chose to template, and a walker
// that knows only today's fields silently misses tomorrow's.

test('secret references are collected from anywhere in a graph', async () => {
  const { collectSecretRefs } = await import('../providers')
  const graph = {
    nodes: [
      { id: 'n1', data: { url: 'https://api.example/x', headers: { auth: 'Bearer {{secrets.vault.kv/data/stripe}}' } } },
      { id: 'n2', data: { body: 'token={{secrets.op.deploy-key}}' } },
    ],
  }
  const refs = collectSecretRefs(graph)
  assert.deepEqual(
    refs.map((r) => `${r.provider}.${r.path}`).sort(),
    ['op.deploy-key', 'vault.kv/data/stripe'],
  )
})

test('one secret referenced twice is collected once', async () => {
  const { collectSecretRefs } = await import('../providers')
  const refs = collectSecretRefs({ a: '{{secrets.vault.k}}', b: '{{secrets.vault.k}}' })
  assert.equal(refs.length, 1)
})

test('a graph with no secret tokens collects nothing', async () => {
  const { collectSecretRefs } = await import('../providers')
  assert.deepEqual(collectSecretRefs({ nodes: [{ data: { text: '{{trigger.input}}' } }] }), [])
})
