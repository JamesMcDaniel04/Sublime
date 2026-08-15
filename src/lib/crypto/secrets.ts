/**
 * Secret encryption/decryption at rest (AES-256-GCM).
 *
 * Storage formats, newest first:
 *   v2:<saltB64>:<ivB64>:<tagB64>:<ctB64>   HKDF-SHA256, per-secret salt
 *   v1:<ivB64>:<tagB64>:<ctB64>             SHA-256 of the key material
 *   b64:<base64payload>                     reversible fallback, non-production
 *
 * v2 is what new writes use. v1 REMAINS READABLE FOREVER — the version prefix
 * exists precisely so the derivation can improve without a data migration, and
 * rows are moved to v2 only by an operator running src/lib/crypto/rotate.ts.
 *
 * Set ENCRYPTION_KEY to any non-empty string; both derivations normalise it to
 * 32 bytes. Prefer high-entropy random material (openssl rand -hex 32): v1's
 * single SHA-256 gives a passphrase no meaningful work factor, and v2's HKDF
 * is a key-derivation function, not a password hash.
 */

import crypto from 'crypto'

// ── Key derivation ─────────────────────────────────────────────────────────

let _warned = false

/**
 * GCM tag length, pinned on BOTH sides.
 *
 * Left unspecified, Node accepts a shorter tag on setAuthTag — and a truncated
 * tag makes forgery dramatically cheaper than the 128-bit tag implies. Pinning
 * it on the decipher is the half that matters; pinning it on the cipher keeps
 * the two obviously symmetrical. (semgrep: gcm-no-tag-length)
 */
const AUTH_TAG_BYTES = 16
const V2_SALT_BYTES = 16
const V2_INFO = Buffer.from('sublime-secret-v2')

/**
 * v1 key derivation: a bare SHA-256 of the key material.
 *
 * Adequate when ENCRYPTION_KEY is high-entropy random, weak when it is a
 * passphrase — one hash per guess is exactly what an offline attacker wants.
 * Kept forever so existing rows stay readable; never used for new writes.
 */
function deriveKeyV1(raw: string): Buffer {
  return crypto.createHash('sha256').update(raw).digest()
}

/**
 * v2 key derivation: HKDF-SHA256 with a per-secret random salt.
 *
 * The salt travels in the envelope, so every secret gets a distinct derived
 * key. Two rows holding the same value no longer produce related ciphertexts,
 * and precomputation against the key material buys an attacker nothing that
 * transfers between rows.
 */
function deriveKeyV2(raw: string, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(raw, 'utf8'), salt, V2_INFO, 32))
}

function getDerivedKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    // Secrets at rest must never silently degrade to reversible base64 in
    // production — refuse to operate instead.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY is required in production')
    }
    // Outside production the fallback is OPT-IN, not ambient: "not production"
    // must not silently mean "not encrypted" — a staging/preview deploy that
    // forgot the key should fail its first secret write. Test runs stay
    // permissive so suites without a key keep working (NODE_TEST_CONTEXT is
    // set by the Node test runner in every spawned test process).
    const optIn =
      process.env.ALLOW_UNENCRYPTED_SECRETS === 'true' ||
      process.env.NODE_ENV === 'test' ||
      Boolean(process.env.NODE_TEST_CONTEXT)
    if (!optIn) {
      throw new Error(
        'ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32`, ' +
          'or set ALLOW_UNENCRYPTED_SECRETS=true to accept reversible base64 storage in local development.',
      )
    }
    if (!_warned) {
      console.warn('ENCRYPTION_KEY not set — secrets stored as reversible base64 (ALLOW_UNENCRYPTED_SECRETS)')
      _warned = true
    }
    return null
  }
  // Derive a 32-byte key regardless of input format/length
  return deriveKeyV1(raw)
}

/**
 * True when a real ENCRYPTION_KEY is configured (AES-256-GCM available).
 * The non-production `b64:` fallback is NOT encryption and returns false.
 */
export function encryptionConfigured(): boolean {
  return Boolean(process.env.ENCRYPTION_KEY)
}

// ── One-way token hashing (webhook trigger secrets) ────────────────────────

/**
 * SHA-256 hex digest of a token. Used to store webhook trigger secrets so the
 * plaintext is never persisted — the secret is shown once at creation/rotation
 * and validated by hashing the presented value. Compare with timingSafeEqualHex.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time compare of two hex digests (returns false on length mismatch). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

// ── Encryption ────────────────────────────────────────────────────────────

/**
 * Encrypt under EXPLICIT key material rather than the ambient env var.
 *
 * Key rotation needs both keys live in one process — the ambient reader can
 * only ever hold one — so rotation goes through these two functions. They are
 * the same AES-256-GCM construction, just with the key passed in.
 */
export function encryptSecretWithKey(plaintext: string, keyMaterial: string): string {
  const salt = crypto.randomBytes(V2_SALT_BYTES)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKeyV2(keyMaterial, salt), iv, {
    authTagLength: AUTH_TAG_BYTES,
  })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    'v2',
    salt.toString('base64'),
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/** Decrypt under explicit key material. Throws when the key does not open it. */
export function decryptSecretWithKey(payload: string, keyMaterial: string): string {
  if (payload.startsWith('b64:')) return Buffer.from(payload.slice(4), 'base64').toString('utf8')

  if (payload.startsWith('v2:')) {
    const [, saltB64, ivB64, tagB64, ctB64] = payload.split(':')
    if (!saltB64 || !ivB64 || !tagB64 || !ctB64) throw new Error('Malformed v2 encrypted secret payload')
    return openGcm(
      deriveKeyV2(keyMaterial, Buffer.from(saltB64, 'base64')),
      Buffer.from(ivB64, 'base64'),
      Buffer.from(tagB64, 'base64'),
      Buffer.from(ctB64, 'base64'),
    )
  }

  if (!payload.startsWith('v1:')) throw new Error(`Unknown secret payload format: ${payload.slice(0, 10)}`)

  const [, ivB64, tagB64, ctB64] = payload.split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed v1 encrypted secret payload')

  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKeyV1(keyMaterial), Buffer.from(ivB64, 'base64'), {
    authTagLength: AUTH_TAG_BYTES,
  })
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  // GCM's auth tag makes this throw on the wrong key rather than returning
  // garbage — which is what lets rotation tell "not mine" from "corrupted".
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}

/** Open an AES-256-GCM envelope with the tag length pinned. */
function openGcm(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES })
  decipher.setAuthTag(tag)
  // GCM's auth tag makes this throw on the wrong key rather than returning
  // garbage — which is what lets rotation tell "not mine" from "corrupted".
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function encryptSecret(plaintext: string): string {
  // Calling this for its side effects: it throws in production without a key
  // and warns once in development, which is the behaviour the b64 fallback
  // below depends on.
  const configured = getDerivedKey()

  if (!configured) {
    // Fallback: reversible base64 encoding (no security)
    return 'b64:' + Buffer.from(plaintext, 'utf8').toString('base64')
  }

  return encryptSecretWithKey(plaintext, process.env.ENCRYPTION_KEY as string)
}

// ── Decryption ────────────────────────────────────────────────────────────

export function decryptSecret(payload: string): string {
  if (payload.startsWith('b64:')) {
    // Legacy unencrypted payloads stay readable, but only when the process is
    // properly configured — production without a key must not run at all.
    if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY is required in production')
    }
    return Buffer.from(payload.slice(4), 'base64').toString('utf8')
  }

  if (payload.startsWith('v2:') || payload.startsWith('v1:')) {
    const key = getDerivedKey()
    if (!key) {
      throw new Error('ENCRYPTION_KEY is required to decrypt stored secrets but is not set')
    }
    return decryptSecretWithKey(payload, process.env.ENCRYPTION_KEY as string)
  }

  throw new Error(`Unknown secret payload format: ${payload.slice(0, 10)}`)
}

// ── authConfig assembly ───────────────────────────────────────────────────

export type AuthType = 'none' | 'api_key' | 'oauth2'

export interface RawAuthInput {
  authType: AuthType
  apiKey?: string
  headerName?: string
  /**
   * A vault Credential backing this connection's api_key auth, instead of an
   * inline encrypted key. Mutually exclusive with `apiKey`: whichever the
   * caller supplies replaces the other, because a row holding both would let
   * the stale inline key win at request time (authHeaders runs before the
   * credential plan, and the plan never overwrites a populated header).
   */
  credentialId?: string
  clientId?: string
  clientSecret?: string
  tokenUrl?: string
  scopes?: string
}

/**
 * Build the `authConfig` JSON blob for storage.
 * Secret fields (apiKey, clientSecret) are encrypted; everything else is plain.
 */
export function buildAuthConfig(input: RawAuthInput): Record<string, unknown> {
  const { authType } = input

  if (authType === 'none') {
    return {}
  }

  if (authType === 'api_key') {
    if (input.credentialId) {
      return {
        credentialId: input.credentialId,
        ...(input.headerName !== undefined && { headerName: input.headerName }),
      }
    }
    return {
      ...(input.apiKey !== undefined && {
        apiKey: encryptSecret(input.apiKey),
      }),
      ...(input.headerName !== undefined && { headerName: input.headerName }),
    }
  }

  if (authType === 'oauth2') {
    return {
      ...(input.clientId !== undefined && { clientId: input.clientId }),
      ...(input.clientSecret !== undefined && {
        clientSecret: encryptSecret(input.clientSecret),
      }),
      ...(input.tokenUrl !== undefined && { tokenUrl: input.tokenUrl }),
      ...(input.scopes !== undefined && { scopes: input.scopes }),
    }
  }

  return {}
}

/**
 * Merge an existing stored authConfig with updated fields from a PUT request.
 * Only re-encrypts fields that were explicitly provided in `input`.
 * Fields omitted from `input` are preserved from `existing`.
 */
export function mergeAuthConfig(
  existing: Record<string, unknown>,
  input: RawAuthInput,
): Record<string, unknown> {
  const { authType } = input

  if (authType === 'none') {
    return {}
  }

  if (authType === 'api_key') {
    // Switching to a vault credential DROPS any inline key rather than merging
    // over it — see RawAuthInput.credentialId for why leaving both is unsafe.
    const rest = { ...existing }
    if (input.credentialId) {
      delete rest.apiKey
      return {
        ...rest,
        credentialId: input.credentialId,
        ...(input.headerName !== undefined && { headerName: input.headerName }),
      }
    }
    if (input.apiKey !== undefined) {
      delete rest.credentialId
      return {
        ...rest,
        apiKey: encryptSecret(input.apiKey),
        ...(input.headerName !== undefined && { headerName: input.headerName }),
      }
    }
    return {
      ...existing,
      ...(input.headerName !== undefined && { headerName: input.headerName }),
    }
  }

  if (authType === 'oauth2') {
    return {
      ...existing,
      ...(input.clientId !== undefined && { clientId: input.clientId }),
      ...(input.clientSecret !== undefined && {
        clientSecret: encryptSecret(input.clientSecret),
      }),
      ...(input.tokenUrl !== undefined && { tokenUrl: input.tokenUrl }),
      ...(input.scopes !== undefined && { scopes: input.scopes }),
    }
  }

  return {}
}

// ── Redacted view for API responses ──────────────────────────────────────

export interface RedactedAuthConfig {
  authType: AuthType
  hasApiKey?: boolean
  /** Non-secret: which vault Credential backs this connection, if any. */
  credentialId?: string
  headerName?: string
  clientId?: string
  tokenUrl?: string
  scopes?: string
  hasClientSecret?: boolean
}

/**
 * Return a safe, non-secret view of authType + authConfig for API responses.
 * Secrets (apiKey, clientSecret) are NEVER included.
 */
export function redactConfig(
  authType: string,
  authConfig: unknown,
): RedactedAuthConfig {
  const cfg =
    authConfig && typeof authConfig === 'object' && !Array.isArray(authConfig)
      ? (authConfig as Record<string, unknown>)
      : {}

  const type = authType as AuthType

  if (type === 'api_key') {
    return {
      authType: type,
      hasApiKey: Boolean(cfg.apiKey),
      ...(typeof cfg.credentialId === 'string' && { credentialId: cfg.credentialId }),
      ...(cfg.headerName !== undefined && {
        headerName: cfg.headerName as string,
      }),
    }
  }

  if (type === 'oauth2') {
    return {
      authType: type,
      ...(cfg.clientId !== undefined && { clientId: cfg.clientId as string }),
      ...(cfg.tokenUrl !== undefined && { tokenUrl: cfg.tokenUrl as string }),
      ...(cfg.scopes !== undefined && { scopes: cfg.scopes as string }),
      hasClientSecret: Boolean(cfg.clientSecret),
    }
  }

  return { authType: 'none' }
}
