/**
 * Agent webhook trigger-secret validation.
 *
 * New secrets are stored as SHA-256 hash (for validation) plus AES-GCM
 * ciphertext (owner-only re-display). Rows minted before hashing carry a
 * PLAINTEXT metadata.triggerSecret; those keep validating so existing
 * integrations don't break, but a successful legacy match returns upgraded
 * metadata — hashed, encrypted, plaintext deleted — for the caller to persist,
 * so the plaintext population only ever shrinks.
 */
import { timingSafeEqual } from 'crypto'
import { encryptSecret, hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'

function legacyPlaintextMatch(provided: string, expected: string) {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type TriggerSecretResult = {
  valid: boolean
  /** Full replacement metadata when a legacy row should be upgraded in place. */
  upgrade: Record<string, unknown> | null
}

export function validateTriggerSecret(
  provided: string,
  metadata: Record<string, unknown>,
): TriggerSecretResult {
  const hash = typeof metadata.triggerSecretHash === 'string' ? metadata.triggerSecretHash : null
  if (hash) {
    // A row carrying BOTH hash and a stale plaintext (half-finished upgrade)
    // validates against the hash only.
    return { valid: timingSafeEqualHex(hashToken(provided), hash), upgrade: null }
  }

  const legacy = typeof metadata.triggerSecret === 'string' ? metadata.triggerSecret : null
  if (!legacy || !legacyPlaintextMatch(provided, legacy)) return { valid: false, upgrade: null }

  const upgrade: Record<string, unknown> = { ...metadata, triggerSecretHash: hashToken(provided) }
  delete upgrade.triggerSecret
  try {
    upgrade.triggerSecretEnc = encryptSecret(provided)
  } catch {
    // No encryption key in this environment: the hash alone still validates
    // future calls, and removing the plaintext is the point of the upgrade.
  }
  return { valid: true, upgrade }
}
