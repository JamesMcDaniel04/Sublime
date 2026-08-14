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

test('development without ENCRYPTION_KEY: falls back to reversible b64', async () => {
  delete process.env.ENCRYPTION_KEY
  setNodeEnv('development')
  const { encryptSecret, decryptSecret } = await freshSecrets()
  const payload = encryptSecret('dev-secret')
  assert.match(payload, /^b64:/)
  assert.equal(decryptSecret(payload), 'dev-secret')
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
