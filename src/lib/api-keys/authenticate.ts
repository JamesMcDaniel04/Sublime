import { timingSafeEqualHex } from '@/lib/crypto/secrets'
import { parseApiKey } from './keys'

/**
 * Authenticating a presented API key.
 *
 * Separated from the database read (injected as `lookup`) so every refusal
 * path is testable without a database — these are the branches where a bug
 * lets a caller in, so they need to be exercised directly rather than through
 * a route.
 */

export interface ApiKeyRow {
  id: string
  organizationId: string
  hash: string
  scopes: string[]
  revokedAt: Date | null
  expiresAt: Date | null
}

export type ApiKeyAuthResult =
  | { ok: true; key: ApiKeyRow }
  | { ok: false; error: string }

/**
 * One refusal message for every failure.
 *
 * Distinguishing "revoked" from "unknown" from "expired" would tell someone
 * working through guesses which of them was once a real key — and which
 * workspace to keep guessing at.
 */
const REFUSED = 'Invalid API key.'

export async function authenticateApiKey(
  header: string | null | undefined,
  lookup: (prefix: string) => Promise<ApiKeyRow | Record<string, unknown> | null>,
  now: Date = new Date(),
): Promise<ApiKeyAuthResult> {
  if (!header) return { ok: false, error: REFUSED }

  // Accept both `Bearer <key>` and a bare key: clients offer it both ways, and
  // refusing the bare form buys nothing.
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim()
  if (!presented) return { ok: false, error: REFUSED }

  const parsed = parseApiKey(presented)
  if (!parsed) return { ok: false, error: REFUSED }

  const row = (await lookup(parsed.prefix)) as ApiKeyRow | null
  if (!row) return { ok: false, error: REFUSED }

  // The prefix is PUBLIC — it is printed in key lists — so finding a row by it
  // proves nothing. The hash is what proves the caller holds the real key.
  if (!timingSafeEqualHex(parsed.hash, row.hash)) return { ok: false, error: REFUSED }

  if (row.revokedAt) return { ok: false, error: REFUSED }
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return { ok: false, error: REFUSED }

  return { ok: true, key: row }
}
