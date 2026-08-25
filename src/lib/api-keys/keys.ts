import { randomBytes } from 'node:crypto'
import { hashToken } from '@/lib/crypto/secrets'

/**
 * API key format, hashing and scopes.
 *
 * The constraint that shapes all of this: the plaintext key is shown once and
 * never stored. So a presented key has to locate its own row without the
 * stored value being reversible. Hence the two halves —
 *
 *     sk_sub_<prefix>_<secret>
 *              ^public  ^never stored
 *
 * The prefix is an indexed, non-secret handle used to FIND the row; the secret
 * is hashed and compared. Looking a key up by its hash alone would work too,
 * but the prefix is what lets a key be displayed in a list ("sk_sub_a1b2…")
 * and revoked by sight, which is how people actually manage keys.
 */

/** Identifies our keys wherever they leak — a logs grep, a public repo scan. */
export const API_KEY_PREFIX = 'sk_sub_'

const PREFIX_BYTES = 6   // 12 hex chars: enough to be unambiguous in a list
const SECRET_BYTES = 24  // 32 base64url chars ≈ 192 bits

/**
 * Every scope a key can hold.
 *
 * A closed list, with no wildcard, deliberately. A `*` scope would silently
 * grant every future capability to keys issued today — which is precisely
 * what scoping a key is meant to prevent.
 */
export const API_SCOPES = [
  'flows:read', 'flows:write', 'flows:execute',
  'agents:read', 'agents:write', 'agents:execute',
  'runs:read',
  'credentials:read',
] as const

export type ApiScope = (typeof API_SCOPES)[number]

export interface GeneratedApiKey {
  /** Shown to the user exactly once. */
  plaintext: string
  /** Stored in the clear; public by design, used to find the row. */
  prefix: string
  /** Stored instead of the key. */
  hash: string
}

/**
 * The prefix is HEX, not base64url, and that is load-bearing.
 *
 * `_` separates the prefix from the secret, and the base64url alphabet
 * CONTAINS `_`. A base64url prefix that happened to include one would be split
 * in the wrong place by parseApiKey, so the lookup would miss and the key
 * would never authenticate — for roughly one key in eight, at random. Hex has
 * no character that collides with the separator.
 *
 * The secret stays base64url: it is taken as everything after the FIRST
 * separator, so an underscore inside it is harmless.
 */
function prefixToken(): string {
  return randomBytes(PREFIX_BYTES).toString('hex')
}

function token(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = prefixToken()
  const secret = token(SECRET_BYTES)
  const plaintext = `${API_KEY_PREFIX}${prefix}_${secret}`
  return { plaintext, prefix, hash: hashToken(plaintext) }
}

/**
 * Split a presented key into the handle that finds its row and the hash that
 * proves it.
 *
 * Returns null rather than throwing for anything malformed: a bad Authorization
 * header is an ordinary 401, not an exceptional condition, and the caller
 * should not have to distinguish "wrong shape" from "wrong key" — nor should
 * the response.
 */
export function parseApiKey(presented: string): { prefix: string; hash: string } | null {
  if (!presented.startsWith(API_KEY_PREFIX)) return null
  const body = presented.slice(API_KEY_PREFIX.length)
  const separator = body.indexOf('_')
  if (separator <= 0) return null

  const prefix = body.slice(0, separator)
  const secret = body.slice(separator + 1)
  if (!prefix || !secret) return null

  return { prefix, hash: hashToken(presented) }
}

/** Keep only scopes we actually recognise, de-duplicated. */
export function normalizeScopes(scopes: unknown): ApiScope[] {
  const list = Array.isArray(scopes) ? scopes : []
  return [...new Set(
    list.filter((scope): scope is ApiScope => API_SCOPES.includes(scope as ApiScope)),
  )]
}

/**
 * Whether a key's scopes permit an operation.
 *
 * `write` implies `read` on the SAME resource — a key allowed to change flows
 * but not list them is a papercut that buys no security. It does not imply
 * `execute`, which is a genuinely different power: editing a flow and running
 * it against production systems are not the same authority.
 */
export function scopeSatisfies(held: readonly string[], required: ApiScope): boolean {
  if (held.includes(required)) return true
  const [resource, action] = required.split(':')
  return action === 'read' && held.includes(`${resource}:write`)
}
