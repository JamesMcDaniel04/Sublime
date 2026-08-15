import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// The module caches derived keys and warn-state at module scope, so each test
// re-imports a fresh copy after adjusting the environment.
async function freshSecrets() {
  const mod = await import(`../secrets?t=${Date.now()}-${Math.random()}`)
  return mod as typeof import('../secrets')
}

const ORIGINAL_ENV = { ...process.env }

// Next's types mark NODE_ENV readonly; tests legitimately vary it.
function setNodeEnv(value: string) {
  Object.assign(process.env, { NODE_ENV: value })
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

test('production without ENCRYPTION_KEY: encryptSecret throws', async () => {
  delete process.env.ENCRYPTION_KEY
  setNodeEnv('production')
  const { encryptSecret } = await freshSecrets()
  assert.throws(() => encryptSecret('top-secret'), /ENCRYPTION_KEY is required in production/)
})

test('production without ENCRYPTION_KEY: decrypting a b64 legacy payload throws', async () => {
  delete process.env.ENCRYPTION_KEY
  setNodeEnv('production')
  const { decryptSecret } = await freshSecrets()
  // Legacy b64 payloads decode without a key in dev, but production must not
  // silently run in unencrypted mode.
  assert.throws(() => decryptSecret('b64:' + Buffer.from('x').toString('base64')), /ENCRYPTION_KEY is required in production/)
})

test('with ENCRYPTION_KEY set: encrypt/decrypt round-trips', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { encryptSecret, decryptSecret } = await freshSecrets()
  const payload = encryptSecret('grn_abc123')
  assert.match(payload, /^v2:/)
  assert.equal(decryptSecret(payload), 'grn_abc123')
})

test('rolling rotation: OLD_ENCRYPTION_KEY still opens rows written under the old key', async () => {
  // Deploy new key as ENCRYPTION_KEY + old as OLD_ENCRYPTION_KEY → the running
  // app reads BOTH while a background rotation re-encrypts rows, so rotation is
  // a rolling operation instead of a maintenance window.
  setNodeEnv('production')
  process.env.ENCRYPTION_KEY = 'old-key-material-0123456789abcdef'
  const first = await freshSecrets()
  const oldRow = first.encryptSecret('secret-under-old-key')

  delete process.env.NODE_TEST_CONTEXT
  process.env.ENCRYPTION_KEY = 'new-key-material-fedcba9876543210'
  process.env.OLD_ENCRYPTION_KEY = 'old-key-material-0123456789abcdef'
  const second = await freshSecrets()
  assert.equal(second.decryptSecret(oldRow), 'secret-under-old-key', 'old-key row unreadable during rotation')
  // New writes use the new key and still round-trip.
  const newRow = second.encryptSecret('secret-under-new-key')
  assert.equal(second.decryptSecret(newRow), 'secret-under-new-key')
})

test('without OLD_ENCRYPTION_KEY, a row under a different key fails loudly', async () => {
  setNodeEnv('production')
  process.env.ENCRYPTION_KEY = 'keyA-material-0123456789abcdef012'
  const a = await freshSecrets()
  const row = a.encryptSecret('secret')

  process.env.ENCRYPTION_KEY = 'keyB-material-fedcba9876543210fed'
  delete process.env.OLD_ENCRYPTION_KEY
  const b = await freshSecrets()
  assert.throws(() => b.decryptSecret(row))
})

test('development without ENCRYPTION_KEY and without opt-in: encryptSecret throws', async () => {
  // "Not production" must not silently mean "not encrypted": a staging or
  // preview deploy that forgot the key should fail its first secret write,
  // not quietly persist reversible base64. NODE_TEST_CONTEXT is deleted to
  // simulate a real (non-test-runner) process.
  delete process.env.ENCRYPTION_KEY
  delete process.env.ALLOW_UNENCRYPTED_SECRETS
  delete process.env.NODE_TEST_CONTEXT
  setNodeEnv('development')
  const { encryptSecret } = await freshSecrets()
  assert.throws(() => encryptSecret('dev-secret'), /ENCRYPTION_KEY/)
})

test('development without ENCRYPTION_KEY: explicit opt-in restores the b64 fallback', async () => {
  delete process.env.ENCRYPTION_KEY
  process.env.ALLOW_UNENCRYPTED_SECRETS = 'true'
  delete process.env.NODE_TEST_CONTEXT // the flag, not the test runner, must be what opts in
  setNodeEnv('development')
  const { encryptSecret, decryptSecret } = await freshSecrets()
  const payload = encryptSecret('dev-secret')
  assert.match(payload, /^b64:/)
  assert.equal(decryptSecret(payload), 'dev-secret')
})

test('NODE_ENV=test without ENCRYPTION_KEY: fallback stays available for suites', async () => {
  delete process.env.ENCRYPTION_KEY
  delete process.env.ALLOW_UNENCRYPTED_SECRETS
  setNodeEnv('test')
  const { encryptSecret } = await freshSecrets()
  assert.match(encryptSecret('test-secret'), /^b64:/)
})

test('production ignores the opt-in flag entirely', async () => {
  delete process.env.ENCRYPTION_KEY
  process.env.ALLOW_UNENCRYPTED_SECRETS = 'true'
  delete process.env.NODE_TEST_CONTEXT
  setNodeEnv('production')
  const { encryptSecret } = await freshSecrets()
  assert.throws(() => encryptSecret('top-secret'), /ENCRYPTION_KEY is required in production/)
})

test('legacy b64 rows stay READABLE without the opt-in flag', async () => {
  // The gate is on writes. Rows written before the gate must keep decrypting
  // (with or without a key) so existing dev databases don't brick.
  delete process.env.ENCRYPTION_KEY
  delete process.env.ALLOW_UNENCRYPTED_SECRETS
  setNodeEnv('development')
  const { decryptSecret } = await freshSecrets()
  assert.equal(decryptSecret('b64:' + Buffer.from('old-row').toString('base64')), 'old-row')
})

// ── v2 envelope: HKDF with a per-secret salt ───────────────────────────────

test('each v2 encryption uses a fresh salt, so identical inputs differ', async () => {
  // A per-secret salt means two rows holding the same secret are not
  // recognisable as equal from the ciphertext alone.
  process.env.ENCRYPTION_KEY = 'salt-test-key'
  const { encryptSecret, decryptSecret } = await freshSecrets()
  const a = encryptSecret('same-value')
  const b = encryptSecret('same-value')
  assert.notEqual(a, b)
  assert.equal(decryptSecret(a), 'same-value')
  assert.equal(decryptSecret(b), 'same-value')
})

test('v1 payloads written before the upgrade stay readable forever', async () => {
  // The point of versioning the envelope: existing rows keep opening with no
  // migration. Built with the v1 construction (sha256 of the key) on purpose.
  process.env.ENCRYPTION_KEY = 'legacy-key'
  const crypto = await import('node:crypto')
  const key = crypto.createHash('sha256').update('legacy-key').digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  const ct = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()])
  const legacy = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')

  const { decryptSecret } = await freshSecrets()
  assert.equal(decryptSecret(legacy), 'legacy-secret')
})

test('a v2 payload does not open under a different key', async () => {
  process.env.ENCRYPTION_KEY = 'key-a'
  const { encryptSecret } = await freshSecrets()
  const payload = encryptSecret('secret')

  process.env.ENCRYPTION_KEY = 'key-b'
  const { decryptSecret } = await freshSecrets()
  assert.throws(() => decryptSecret(payload))
})

test('a truncated auth tag is rejected rather than accepted short', async () => {
  // Without an explicit authTagLength, Node accepts GCM tags shorter than 16
  // bytes, which makes forgery dramatically cheaper. Flagged by semgrep's
  // gcm-no-tag-length rule; fixed by pinning the length on both sides.
  process.env.ENCRYPTION_KEY = 'tag-key'
  const { encryptSecret, decryptSecret } = await freshSecrets()
  const [version, salt, iv, tag, ct] = encryptSecret('secret').split(':')
  const shortTag = Buffer.from(tag, 'base64').subarray(0, 8).toString('base64')
  assert.throws(() => decryptSecret([version, salt, iv, shortTag, ct].join(':')))
})

test('explicit-key encrypt/decrypt (the rotation path) round-trips on v2', async () => {
  const { encryptSecretWithKey, decryptSecretWithKey } = await freshSecrets()
  const payload = encryptSecretWithKey('rotated', 'new-key')
  assert.match(payload, /^v2:/)
  assert.equal(decryptSecretWithKey(payload, 'new-key'), 'rotated')
  assert.throws(() => decryptSecretWithKey(payload, 'other-key'))
})
