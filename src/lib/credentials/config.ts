/**
 * Credential config: encrypt on the way in, redact on the way out, decrypt only
 * for server-side injection.
 *
 * Secret fields go through `encryptSecret` (AES-256-GCM, same helper backing
 * McpConnection.authConfig); metadata — a username, a header name, a query
 * param — stays plaintext because the editor and the API need to show it.
 *
 * SECRETS DISCIPLINE: `decryptCredentialConfig`'s result is transient. It exists
 * to build an outbound request and must never be persisted to a graph, a run
 * row, a log line, or a client response.
 */
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import type { CredentialType, CredentialInput, DecryptedCredential, RedactedCredential, CustomAuthEntry, CustomAuthEntryInput } from './types'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/**
 * Encrypt the rows that carry a value. A row with no value is a
 * "keep the stored one" marker, which only `mergeEntries` can resolve — on
 * create there is nothing to keep, so it is dropped rather than stored as an
 * encrypted empty string that would inject a blank header at request time.
 */
const encEntries = (entries: CustomAuthEntryInput[] | undefined) =>
  (entries ?? [])
    .filter((entry) => entry.name.trim() && entry.value)
    .map((entry) => ({ name: entry.name, value: encryptSecret(entry.value as string) }))

/**
 * Resolve an update's rows against what is stored.
 *
 * The submitted list is AUTHORITATIVE: a row the editor no longer sends is
 * deleted. A row with no value inherits the stored ciphertext, looked up by
 * `originalName` so a rename keeps its secret — matching on the new name would
 * silently orphan the value the editor can never repopulate.
 */
function mergeEntries(existing: unknown, submitted: CustomAuthEntryInput[] | undefined) {
  if (!submitted) return existing
  const stored = new Map(
    (Array.isArray(existing) ? existing : []).map((entry) => [String((entry as CustomAuthEntry).name), (entry as CustomAuthEntry).value]),
  )
  return submitted
    .filter((entry) => entry.name.trim())
    .map((entry) => {
      if (entry.value) return { name: entry.name, value: encryptSecret(entry.value) }
      const kept = stored.get(entry.originalName ?? entry.name)
      return kept === undefined ? null : { name: entry.name, value: kept }
    })
    .filter((entry): entry is { name: string; value: string } => entry !== null)
}

/** Encrypt secret fields, keep metadata plaintext. Only provided fields are set. */
export function buildCredentialConfig(input: CredentialInput): Record<string, unknown> {
  const caCert = input.caCert !== undefined ? { caCert: encryptSecret(input.caCert) } : {}
  switch (input.type) {
    case 'basic':
    case 'digest':
      return {
        ...(input.username !== undefined && { username: input.username }),
        ...(input.password !== undefined && { password: encryptSecret(input.password) }),
      }
    case 'bearer':
      return { ...(input.token !== undefined && { token: encryptSecret(input.token) }), ...caCert }
    case 'apiKeyHeader':
      return {
        ...(input.headerName !== undefined && { headerName: input.headerName }),
        ...(input.key !== undefined && { key: encryptSecret(input.key) }),
        ...caCert,
      }
    case 'apiKeyQuery':
      return {
        ...(input.queryParam !== undefined && { queryParam: input.queryParam }),
        ...(input.key !== undefined && { key: encryptSecret(input.key) }),
      }
    case 'custom':
      return {
        ...(input.headers !== undefined && { headers: encEntries(input.headers) }),
        ...(input.query !== undefined && { query: encEntries(input.query) }),
      }
    case 'oauth1':
      return {
        ...(input.consumerKey !== undefined && { consumerKey: input.consumerKey }),
        ...(input.consumerSecret !== undefined && { consumerSecret: encryptSecret(input.consumerSecret) }),
        ...(input.accessToken !== undefined && { accessToken: encryptSecret(input.accessToken) }),
        ...(input.tokenSecret !== undefined && { tokenSecret: encryptSecret(input.tokenSecret) }),
        ...(input.signatureMethod !== undefined && { signatureMethod: input.signatureMethod }),
      }
    case 'oauth2':
      return {
        ...(input.grantType !== undefined && { grantType: input.grantType }),
        ...(input.accessToken !== undefined && { accessToken: encryptSecret(input.accessToken) }),
        ...(input.tokenUrl !== undefined && { tokenUrl: input.tokenUrl }),
        ...(input.clientId !== undefined && { clientId: input.clientId }),
        ...(input.clientSecret !== undefined && { clientSecret: encryptSecret(input.clientSecret) }),
        ...(input.scope !== undefined && { scope: input.scope }),
        ...(input.audience !== undefined && { audience: input.audience }),
        ...(input.clientAuth !== undefined && { clientAuth: input.clientAuth }),
      }
    default:
      return {}
  }
}

/**
 * Merge on update: re-encrypt only the fields present in `input` and preserve
 * the rest, so editing a header name doesn't require re-typing the key.
 */
export function mergeCredentialConfig(existing: Record<string, unknown>, input: CredentialInput): Record<string, unknown> {
  const merged = { ...existing, ...buildCredentialConfig(input) }
  if (input.type !== 'custom') return merged
  // Custom rows can't use the plain spread: the submitted list is the whole
  // truth (so deletions stick) and blank values must inherit from `existing`.
  return {
    ...merged,
    ...(input.headers !== undefined && { headers: mergeEntries(existing.headers, input.headers) }),
    ...(input.query !== undefined && { query: mergeEntries(existing.query, input.query) }),
  }
}

const redactEntries = (value: unknown) =>
  Array.isArray(value)
    ? value.map((entry) => ({ name: String((entry as CustomAuthEntry).name), hasValue: Boolean((entry as CustomAuthEntry).value) }))
    : []

/** Non-secret view for API responses. Never includes a secret value. */
export function redactCredential(type: string, authConfig: unknown): RedactedCredential {
  const cfg = asRecord(authConfig)
  const t = type as CredentialType
  switch (t) {
    case 'basic':
    case 'digest':
      return { type: t, ...(cfg.username !== undefined && { username: String(cfg.username) }), hasPassword: Boolean(cfg.password) }
    case 'bearer':
      return { type: t, hasToken: Boolean(cfg.token), ...(cfg.caCert ? { hasCaCert: true as const } : {}) }
    case 'apiKeyHeader':
      return { type: t, ...(cfg.headerName !== undefined && { headerName: String(cfg.headerName) }), hasKey: Boolean(cfg.key), ...(cfg.caCert ? { hasCaCert: true as const } : {}) }
    case 'apiKeyQuery':
      return { type: t, ...(cfg.queryParam !== undefined && { queryParam: String(cfg.queryParam) }), hasKey: Boolean(cfg.key) }
    case 'custom':
      return { type: t, headers: redactEntries(cfg.headers), query: redactEntries(cfg.query) }
    case 'oauth1':
      return {
        type: t,
        ...(cfg.consumerKey !== undefined && { consumerKey: String(cfg.consumerKey) }),
        hasConsumerSecret: Boolean(cfg.consumerSecret),
        hasAccessToken: Boolean(cfg.accessToken),
        hasTokenSecret: Boolean(cfg.tokenSecret),
        signatureMethod: cfg.signatureMethod === 'HMAC-SHA1' ? 'HMAC-SHA1' : 'HMAC-SHA256',
      }
    case 'oauth2':
      return {
        type: t,
        grantType: cfg.grantType === 'clientCredentials' ? 'clientCredentials' : 'staticToken',
        hasAccessToken: Boolean(cfg.accessToken),
        ...(cfg.tokenUrl !== undefined && { tokenUrl: String(cfg.tokenUrl) }),
        ...(cfg.clientId !== undefined && { clientId: String(cfg.clientId) }),
        hasClientSecret: Boolean(cfg.clientSecret),
        ...(cfg.scope !== undefined && { scope: String(cfg.scope) }),
        ...(cfg.audience !== undefined && { audience: String(cfg.audience) }),
        clientAuth: cfg.clientAuth === 'body' ? 'body' : 'header',
      }
    default:
      return { type: t }
  }
}

const decEntries = (value: unknown): CustomAuthEntry[] =>
  Array.isArray(value)
    ? value.map((entry) => ({
        name: String((entry as CustomAuthEntry).name),
        value: decryptSecret(String((entry as CustomAuthEntry).value)),
      }))
    : []

/** Decrypt secret fields for server-side injection. Callers must not persist the result. */
export function decryptCredentialConfig(type: string, authConfig: unknown): DecryptedCredential {
  const cfg = asRecord(authConfig)
  const t = type as CredentialType
  const dec = (value: unknown) => (value == null ? undefined : decryptSecret(String(value)))
  switch (t) {
    case 'basic':
    case 'digest':
      return { type: t, username: cfg.username as string | undefined, password: dec(cfg.password) }
    case 'bearer':
      return { type: t, token: dec(cfg.token), caCert: dec(cfg.caCert) }
    case 'apiKeyHeader':
      return { type: t, headerName: cfg.headerName as string | undefined, key: dec(cfg.key), caCert: dec(cfg.caCert) }
    case 'apiKeyQuery':
      return { type: t, queryParam: cfg.queryParam as string | undefined, key: dec(cfg.key) }
    case 'custom':
      return { type: t, headers: decEntries(cfg.headers), query: decEntries(cfg.query) }
    case 'oauth1':
      return {
        type: t,
        consumerKey: cfg.consumerKey as string | undefined,
        consumerSecret: dec(cfg.consumerSecret),
        accessToken: dec(cfg.accessToken),
        tokenSecret: dec(cfg.tokenSecret),
        signatureMethod: cfg.signatureMethod === 'HMAC-SHA1' ? 'HMAC-SHA1' : 'HMAC-SHA256',
      }
    case 'oauth2':
      return {
        type: t,
        grantType: cfg.grantType === 'clientCredentials' ? 'clientCredentials' : 'staticToken',
        accessToken: dec(cfg.accessToken),
        tokenUrl: cfg.tokenUrl as string | undefined,
        clientId: cfg.clientId as string | undefined,
        clientSecret: dec(cfg.clientSecret),
        scope: cfg.scope as string | undefined,
        audience: cfg.audience as string | undefined,
        clientAuth: cfg.clientAuth === 'body' ? 'body' : 'header',
      }
    default:
      return { type: t }
  }
}
