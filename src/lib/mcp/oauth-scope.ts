/**
 * OAuth scope hygiene for user-added MCP servers.
 *
 * There is no allow-list of scope VALUES — arbitrary MCP servers define their
 * own — but the ?scope= query param must not be a free-text channel into the
 * authorization redirect. RFC 6749 §3.3 defines scope-token as %x21 / %x23-5B
 * / %x5D-7E (printable ASCII minus space, double-quote, and backslash),
 * space-separated.
 */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/
const MAX_SCOPE_LENGTH = 512

/** Returns the normalised scope string, or null when the input is not a
 *  well-formed RFC 6749 scope list. */
export function sanitizeOAuthScope(raw: string): string | null {
  // Control characters (newlines, tabs) are rejected outright rather than
  // normalised away — laundering malformed input hides an injection attempt.
  if (!/^[\x20-\x7e]*$/.test(raw)) return null
  const tokens = raw.trim().split(/ +/).filter(Boolean)
  if (tokens.length === 0) return null
  if (!tokens.every((token) => SCOPE_TOKEN.test(token))) return null
  const normalised = tokens.join(' ')
  return normalised.length <= MAX_SCOPE_LENGTH ? normalised : null
}
