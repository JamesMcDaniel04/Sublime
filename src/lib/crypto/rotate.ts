/**
 * ENCRYPTION_KEY rotation, by ciphertext SHAPE rather than by field name.
 *
 * Secrets live in a dozen places — scalar columns, JSON blobs, arrays of
 * {name,value} header rows, nested trigger config. A rotation that enumerated
 * those fields would silently skip the next one anybody adds, which is the
 * same class of failure as audit coverage that grows per-feature: it looks
 * complete right up until it isn't.
 *
 * So rotation walks a value deeply and rewrites any STRING that is a
 * ciphertext (`v1:` or `b64:`). A new secret field is covered the day it is
 * written, with no registry to update.
 *
 * Two invariants make it safe to run against production:
 *   - Never destroy what it cannot read. A value that does not open under the
 *     old key is left byte-identical and counted as `failed`.
 *   - Re-runnable. A value already under the new key is left alone, so an
 *     interrupted rotation is resumed by running it again.
 */
import { decryptSecretWithKey, encryptSecretWithKey } from './secrets'

export type CiphertextKind = 'v1' | 'b64' | 'plaintext'

/** What a stored string IS: real encryption, the reversible fallback, or neither. */
export function classifyCiphertext(value: string): CiphertextKind {
  if (value.startsWith('v1:')) return 'v1'
  if (value.startsWith('b64:')) return 'b64'
  return 'plaintext'
}

export type RotationResult = {
  value: unknown
  /** Ciphertexts re-encrypted from the old key to the new one. */
  rotated: number
  /** `b64:` fallback values promoted to real AES-256-GCM encryption. */
  upgraded: number
  /** Ciphertexts that opened under neither key — left untouched, needs a human. */
  failed: number
}

function rotateString(
  value: string,
  oldKey: string,
  newKey: string,
  tally: { rotated: number; upgraded: number; failed: number },
): string {
  const kind = classifyCiphertext(value)
  if (kind === 'plaintext') return value

  // A `b64:` row is reversible by anyone holding the database. Rotation is
  // the moment to promote it, not to faithfully preserve a non-secret.
  if (kind === 'b64') {
    const plaintext = decryptSecretWithKey(value, oldKey)
    tally.upgraded += 1
    return encryptSecretWithKey(plaintext, newKey)
  }

  let plaintext: string
  try {
    plaintext = decryptSecretWithKey(value, oldKey)
  } catch {
    // Already under the new key? Then there is nothing to do and the row is
    // healthy — that is what makes an interrupted rotation resumable.
    try {
      decryptSecretWithKey(value, newKey)
      return value
    } catch {
      tally.failed += 1
      return value
    }
  }
  tally.rotated += 1
  return encryptSecretWithKey(plaintext, newKey)
}

/** Re-encrypt every ciphertext reachable from `value` under the new key. */
export function rotateCiphertextsDeep(value: unknown, oldKey: string, newKey: string): RotationResult {
  const tally = { rotated: 0, upgraded: 0, failed: 0 }

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return rotateString(node, oldKey, newKey, tally)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, item]) => [key, walk(item)]))
    }
    return node
  }

  return { value: walk(value), ...tally }
}

/** Count ciphertexts by kind — the `b64` tally is the plaintext-exposure report. */
export function countCiphertextsDeep(value: unknown): { v1: number; b64: number } {
  const counts = { v1: 0, b64: 0 }

  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      const kind = classifyCiphertext(node)
      if (kind !== 'plaintext') counts[kind] += 1
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach(walk)
  }

  walk(value)
  return counts
}
