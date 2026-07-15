/**
 * Credential redaction for exports.
 *
 * An export leaves the platform, so anything credential-shaped must be stripped.
 * Redacting only Authorization headers is NOT enough — in practice secrets hide
 * in several places a user typed by hand:
 *
 *   https://user:pass@host/x            ← basic-auth userinfo in the URL
 *   https://host/x?api_key=SECRET       ← credential in the query string
 *   query:  {"access_token":"SECRET"}   ← credential in the query field
 *   body:   {"client_secret":"SECRET"}  ← APIs that authenticate via the body
 *
 * The rule is by NAME, not by value: a key that names a credential is redacted
 * wherever it appears (including nested). That's deliberately conservative —
 * over-redacting a field costs the user a re-entry, under-redacting leaks a
 * live token into a file they'll paste into another product.
 */

/** Key names that are credentials by definition, wherever they appear. */
const CREDENTIAL_KEY =
  /(^|[_\-.])(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|passphrase|credential|auth|authorization|bearer|session[_-]?id|signature|private[_-]?key)([_\-.]|$)/i

export const REDACTED = 'redacted'

export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key.trim())
}

/**
 * Strip credentials from a URL: basic-auth userinfo and any credential-named
 * query parameter. The URL itself survives so the step is still rebuildable.
 * A templated/invalid URL ({{token}} etc.) is returned untouched — it holds no
 * literal secret, and parsing it would throw.
 */
export function redactUrl(url: string): string {
  if (!url.trim()) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url // not an absolute URL (often a template) — nothing literal to strip
  }
  if (parsed.username || parsed.password) {
    parsed.username = ''
    parsed.password = ''
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isCredentialKey(key)) parsed.searchParams.set(key, REDACTED)
  }
  return parsed.toString()
}

/**
 * Recursively redact credential-named keys in any JSON-ish value. Strings that
 * parse as JSON are handled too — the builder stores `query`/`headers`/`body` as
 * free text, so a token is usually inside a JSON string, not a real object.
 */
export function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isCredentialKey(key) ? REDACTED : redactDeep(item),
      ]),
    )
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(redactDeep(JSON.parse(trimmed)))
      } catch {
        return value // not actually JSON — leave it alone
      }
    }
  }
  return value
}
