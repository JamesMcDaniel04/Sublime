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
import type { CredentialType, CredentialInput, DecryptedCredential, RedactedCredential, CustomAuthEntry } from './types'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const encEntries = (entries: CustomAuthEntry[] | undefined) =>
  (entries ?? []).filter((entry) => entry.name.trim()).map((entry) => ({ name: entry.name, value: encryptSecret(entry.value) }))

/** Encrypt secret fields, keep metadata plaintext. Only provided fields are set. */
export function buildCredentialConfig(input: CredentialInput): Record<string, unknown> {
  const caCert = input.caCert !== undefined ? { caCert: encryptSecret(input.caCert) } : {}
  switch (input.type) {
    case 'basic':
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
    default:
      return {}
  }
}

/**
 * Merge on update: re-encrypt only the fields present in `input` and preserve
 * the rest, so editing a header name doesn't require re-typing the key.
 */
export function mergeCredentialConfig(existing: Record<string, unknown>, input: CredentialInput): Record<string, unknown> {
  return { ...existing, ...buildCredentialConfig(input) }
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
      return { type: t, ...(cfg.username !== undefined && { username: String(cfg.username) }), hasPassword: Boolean(cfg.password) }
    case 'bearer':
      return { type: t, hasToken: Boolean(cfg.token), ...(cfg.caCert && { hasCaCert: true }) }
    case 'apiKeyHeader':
      return { type: t, ...(cfg.headerName !== undefined && { headerName: String(cfg.headerName) }), hasKey: Boolean(cfg.key), ...(cfg.caCert && { hasCaCert: true }) }
    case 'apiKeyQuery':
      return { type: t, ...(cfg.queryParam !== undefined && { queryParam: String(cfg.queryParam) }), hasKey: Boolean(cfg.key) }
    case 'custom':
      return { type: t, headers: redactEntries(cfg.headers), query: redactEntries(cfg.query) }
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
      return { type: t, username: cfg.username as string | undefined, password: dec(cfg.password) }
    case 'bearer':
      return { type: t, token: dec(cfg.token), caCert: dec(cfg.caCert) }
    case 'apiKeyHeader':
      return { type: t, headerName: cfg.headerName as string | undefined, key: dec(cfg.key), caCert: dec(cfg.caCert) }
    case 'apiKeyQuery':
      return { type: t, queryParam: cfg.queryParam as string | undefined, key: dec(cfg.key) }
    case 'custom':
      return { type: t, headers: decEntries(cfg.headers), query: decEntries(cfg.query) }
    default:
      return { type: t }
  }
}
