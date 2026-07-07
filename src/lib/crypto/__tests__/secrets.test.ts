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
  assert.match(payload, /^v1:/)
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
