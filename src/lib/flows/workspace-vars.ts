/**
 * Workspace variables — the `{{workspace.<key>}}` token.
 *
 * n8n calls these `$vars`. Sublime had nothing, so every flow hardcoded its
 * channel ids, thresholds and base URLs, and changing one meant editing every
 * flow that mentioned it with no way to find which those were.
 *
 * **Why not `{{vars.<key>}}`.** `{{var.<name>}}` already exists and is
 * FLOW-scoped, written by variable steps within a single run. A workspace
 * constant one letter away from a per-run value is a mistake that would be
 * found in production, by someone whose flow read a stale value and did not
 * notice. `workspace` cannot be misread.
 *
 * **Why keys are restricted.** Values are plain text readable by any member —
 * right for a channel id, wrong for a token. Without a guard this table
 * quietly becomes a secrets store with none of the credential vault's
 * placeholder-only reveal, rotation or lifecycle audit. Credential-shaped keys
 * are refused with the vault named, so the distinction cannot erode by
 * accident.
 */

/** The token root this module owns. */
export const WORKSPACE_VAR_ROOT = 'workspace'

/** Identifiers only: letters, digits, underscore, hyphen. */
const KEY_RE = /^[a-z0-9_-]+$/
const MAX_KEY_LENGTH = 64

/**
 * Key names that mean "this is a credential". Matched as WHOLE key or whole
 * underscore/hyphen-separated word, never as a substring — `tokens_per_batch`
 * and `password_reset_flow_id` are legitimate names that a substring match
 * would reject, and a validator that cries wolf gets worked around.
 */
const CREDENTIAL_WORDS = new Set([
  'key', 'apikey', 'secret', 'password', 'passwd', 'token', 'credential',
  'auth', 'bearer', 'privatekey', 'pat',
])

/** Whole-key forms that are credential-shaped however they are spelled. */
const CREDENTIAL_KEYS = new Set([
  'api_key', 'apikey', 'access_token', 'refresh_token', 'client_secret',
  'client_id', 'private_key', 'secret_key', 'auth_token',
])

export function normalizeVariableKey(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Why this key cannot be used, or null when it is fine.
 *
 * Returns a message rather than a boolean: every rejection here is something
 * the author has to fix, and "invalid key" without a reason is the kind of
 * error people file bugs about.
 */
export function variableKeyProblem(raw: string): string | null {
  const key = normalizeVariableKey(raw)
  if (!key) return 'Give the variable a name.'
  if (key.length > MAX_KEY_LENGTH) return `Keep the name under ${MAX_KEY_LENGTH} characters.`
  if (key.includes('.')) {
    return 'Names cannot contain a dot — {{workspace.a.b}} would be ambiguous. Use an underscore.'
  }
  if (!KEY_RE.test(key)) {
    return 'Use letters, numbers, underscores or hyphens only.'
  }

  const words = key.split(/[_-]/)
  const credentialShaped =
    CREDENTIAL_KEYS.has(key) ||
    CREDENTIAL_WORDS.has(key) ||
    // A trailing "…_secret" / "…_token" reads as a credential; a leading
    // "token_…" (tokens_per_batch) does not.
    CREDENTIAL_WORDS.has(words[words.length - 1] ?? '')

  if (credentialShaped) {
    return 'That looks like a credential. Workspace variables are plain text any member can read — store credentials in the vault instead.'
  }
  return null
}

/**
 * Resolve a `workspace.<key>` path, or undefined when the path is not ours.
 *
 * The BARE root resolves to undefined on purpose: `{{workspace}}` would
 * serialize every variable into whatever field it appears in — a prompt, an
 * HTTP body — which is a disclosure nobody asked for. Values are read one key
 * at a time.
 */
export function workspaceVarsToken(path: string, vars: Record<string, string>): unknown {
  const parts = path.trim().split('.')
  if (parts[0] !== WORKSPACE_VAR_ROOT) return undefined
  if (parts.length !== 2) return undefined
  return vars[normalizeVariableKey(parts[1])]
}
