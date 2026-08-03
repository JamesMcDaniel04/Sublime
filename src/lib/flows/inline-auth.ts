/**
 * Retiring the HTTP node's inline `auth` option in favour of the credential
 * vault.
 *
 * `http.data.auth` stores its secret fields IN the graph. A graph is a
 * client-editable JSON blob that fans out to publishedGraph, FlowVersion
 * snapshots, FlowRun.graphSnapshot, five export targets, copilot grounding,
 * Flow Jam patches, and the clipboard — every one an independent place a secret
 * can escape, and each needing its own redactor forever. Commit 6c822f7 closed
 * one such hole (export); the durable fix is for the secret not to be there.
 *
 * BUT an inline value may be a `{{token}}` expression rather than a literal,
 * and that is NOT a secret — it is a reference resolved at run time from data
 * the flow already carries. The vault only stores static secrets, so:
 *
 *   literal   ("sk_live_abc")            → a secret, must move to the vault
 *   token     ("{{trigger.input.key}}")  → not a secret, may stay inline
 *   mixed     ("Bearer {{x}}")           → treated as a literal (the safe read)
 */

/** The auth-option fields that carry a secret value. Mirrors http.ts's list. */
export const INLINE_AUTH_SECRET_FIELDS = ['password', 'token', 'value'] as const
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
])

const FULL_TOKEN_RE = /^\{\{\s*[^{}]+?\s*\}\}$/

/**
 * Is this inline value a pure runtime reference (safe to leave in the graph) or
 * does it contain a literal secret (must be vaulted)?
 *
 * A value that is ENTIRELY one token is a reference. Anything else — a bare
 * literal, or a literal with a token embedded — is treated as containing a
 * secret. Erring this direction costs a migration of something harmless; erring
 * the other way leaves a real secret in the graph.
 */
export function isRuntimeReference(value: string): boolean {
  return FULL_TOKEN_RE.test(value.trim())
}

/** Secret-bearing fields of this auth option that hold a literal. */
export function literalAuthSecrets(auth: unknown): string[] {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return []
  const record = auth as Record<string, unknown>
  return INLINE_AUTH_SECRET_FIELDS.filter((field) => {
    const value = record[field]
    return typeof value === 'string' && value.trim() !== '' && !isRuntimeReference(value)
  })
}

/** True when this node still carries a literal secret inline. */
export function hasInlineLiteralSecret(node: { type: string; data?: unknown }): boolean {
  if (node.type !== 'http') return false
  const data = node.data as { auth?: unknown } | undefined
  return literalAuthSecrets(data?.auth).length > 0
}

export function literalSensitiveHeaders(headers: unknown): string[] {
  if (typeof headers !== 'string' || !headers.trim()) return []
  try {
    const parsed = JSON.parse(headers)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.entries(parsed as Record<string, unknown>).flatMap(([name, value]) =>
      SENSITIVE_HEADER_NAMES.has(name.trim().toLowerCase())
      && typeof value === 'string'
      && value.trim()
      && !isRuntimeReference(value)
        ? [name]
        : [],
    )
  } catch {
    return []
  }
}

export function inlineLiteralSecretNodes(graph: { nodes: Array<{ id: string; type: string; data?: unknown }> }) {
  return graph.nodes.flatMap((node) => {
    if (node.type !== 'http') return []
    const data = node.data as { auth?: unknown; headers?: unknown } | undefined
    const fields = [
      ...literalAuthSecrets(data?.auth),
      ...literalSensitiveHeaders(data?.headers).map((name) => `header:${name}`),
    ]
    return fields.length ? [{ nodeId: node.id, fields }] : []
  })
}
