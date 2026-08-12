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

import { isCredentialKey } from '@/lib/export/redact'

/** The auth-option fields that carry a secret value. Mirrors http.ts's list. */
export const INLINE_AUTH_SECRET_FIELDS = ['password', 'token', 'value'] as const
// Fixed names kept for explicitness; isCredentialKey (shared with the export
// redactor) is what gives the save-time gate the same reach as export
// redaction — e.g. X-Shopify-Access-Token — so a header the export would
// redact can't be persisted into the graph in the first place.
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
])

function isSensitiveHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return SENSITIVE_HEADER_NAMES.has(lower) || isCredentialKey(lower)
}

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
      isSensitiveHeaderName(name)
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

function literalCredentialPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => literalCredentialPaths(item, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (
        isCredentialKey(key)
        && typeof item === 'string'
        && item.trim()
        && !isRuntimeReference(item)
      ) return [`${path}.${key}`]
      return literalCredentialPaths(item, `${path}.${key}`)
    })
  }
  if (typeof value !== 'string' || !value.trim()) return []
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return literalCredentialPaths(JSON.parse(trimmed), path)
    } catch {
      return []
    }
  }
  // Query/body editors also accept form-encoded text.
  if (trimmed.includes('=')) {
    try {
      return [...new URLSearchParams(trimmed).entries()].flatMap(([key, item]) =>
        isCredentialKey(key) && item.trim() && !isRuntimeReference(item) ? [`${path}.${key}`] : [],
      )
    } catch {
      return []
    }
  }
  return []
}

function literalUrlCredentials(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    const query = value.split('?')[1]?.split('#')[0]
    return query ? literalCredentialPaths(query, 'url.query') : []
  }
  const fields: string[] = []
  if ((parsed.username || parsed.password) && !isRuntimeReference(`${parsed.username}${parsed.password}`)) {
    fields.push('url.userinfo')
  }
  for (const [key, item] of parsed.searchParams) {
    if (isCredentialKey(key) && item.trim() && !isRuntimeReference(item)) fields.push(`url.query.${key}`)
  }
  return fields
}

/** Deep scrub mirroring literalCredentialPaths: literal credential-named
 *  values become '' (which the detector ignores), never a marker string the
 *  detector would flag again. Shape and non-secret values are preserved. */
function scrubDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        isCredentialKey(key) && typeof item === 'string' && item.trim() && !isRuntimeReference(item)
          ? [key, '']
          : [key, scrubDeep(item)],
      ),
    )
  }
  if (typeof value !== 'string' || !value.trim()) return value
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(scrubDeep(JSON.parse(trimmed)))
    } catch {
      return value
    }
  }
  if (trimmed.includes('=')) {
    try {
      const params = new URLSearchParams(trimmed)
      let changed = false
      for (const [key, item] of [...params.entries()]) {
        if (isCredentialKey(key) && item.trim() && !isRuntimeReference(item)) {
          params.set(key, '')
          changed = true
        }
      }
      return changed ? params.toString() : value
    } catch {
      return value
    }
  }
  return value
}

function scrubHeaders(headers: unknown): unknown {
  if (typeof headers !== 'string' || !headers.trim()) return headers
  try {
    const parsed = JSON.parse(headers)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return headers
    let changed = false
    const scrubbed = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([name, value]) => {
        if (isSensitiveHeaderName(name) && typeof value === 'string' && value.trim() && !isRuntimeReference(value)) {
          changed = true
          return [name, '']
        }
        return [name, value]
      }),
    )
    return changed ? JSON.stringify(scrubbed) : headers
  } catch {
    return headers
  }
}

function scrubUrl(url: string): string {
  if (!url.trim()) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not an absolute URL (often templated) — scrub only the query substring
    // the detector inspects, leaving the rest byte-identical.
    const [base, rest] = [url.split('?')[0], url.split('?').slice(1).join('?')]
    if (!rest) return url
    const query = rest.split('#')[0]
    const hash = rest.includes('#') ? `#${rest.split('#').slice(1).join('#')}` : ''
    return `${base}?${String(scrubDeep(query))}${hash}`
  }
  parsed.username = ''
  parsed.password = ''
  for (const [key, item] of [...parsed.searchParams.entries()]) {
    if (isCredentialKey(key) && item.trim() && !isRuntimeReference(item)) parsed.searchParams.set(key, '')
  }
  return parsed.toString()
}

/**
 * Remove literal inline secrets from an IMPORTED graph, one warning per
 * affected step. Interactive saves keep the hard reject (a user typing a
 * secret should be told, not silently edited), but an imported document is
 * foreign: rejecting the whole file leaves no path forward, while stripping
 * costs only re-attaching a vault credential — and guarantees the secret is
 * never persisted.
 */
export function stripInlineLiteralSecrets<
  G extends { nodes: Array<{ id: string; type: string; data?: unknown }> },
>(graph: G): { graph: G; warnings: string[] } {
  const flagged = inlineLiteralSecretNodes(graph)
  if (!flagged.length) return { graph, warnings: [] }
  const fieldsById = new Map(flagged.map((entry) => [entry.nodeId, entry.fields]))
  const nodes = graph.nodes.map((node) => {
    if (!fieldsById.has(node.id)) return node
    const data = { ...(node.data as Record<string, unknown>) }
    if (node.type === 'http') {
      if (data.auth && typeof data.auth === 'object' && !Array.isArray(data.auth)) {
        const auth = { ...(data.auth as Record<string, unknown>) }
        for (const field of literalAuthSecrets(auth)) delete auth[field]
        data.auth = auth
      }
      data.headers = scrubHeaders(data.headers)
      if (typeof data.url === 'string') data.url = scrubUrl(data.url)
      if (data.query !== undefined) data.query = scrubDeep(data.query)
      if (data.body !== undefined) data.body = scrubDeep(data.body)
      if (data.cookies !== undefined) data.cookies = scrubDeep(data.cookies)
    } else if (node.type === 'tool' && data.args !== undefined) {
      data.args = scrubDeep(data.args)
    }
    return { ...node, data }
  })
  const labelOf = (id: string) => {
    const node = graph.nodes.find((candidate) => candidate.id === id)
    const label = (node?.data as { label?: string } | undefined)?.label
    return label?.trim() || id
  }
  const warnings = flagged.map(
    (entry) =>
      `Removed inline secret${entry.fields.length > 1 ? 's' : ''} (${entry.fields.join(', ')}) from step "${labelOf(entry.nodeId)}" — attach a saved credential instead.`,
  )
  return { graph: { ...graph, nodes }, warnings }
}

export function inlineLiteralSecretNodes(graph: { nodes: Array<{ id: string; type: string; data?: unknown }> }) {
  return graph.nodes.flatMap((node) => {
    const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data)
      ? node.data as Record<string, unknown>
      : {}
    const fields = node.type === 'http'
      ? [
          ...literalAuthSecrets(data.auth),
          ...literalSensitiveHeaders(data.headers).map((name) => `header:${name}`),
          ...literalUrlCredentials(data.url),
          ...literalCredentialPaths(data.query, 'query'),
          ...literalCredentialPaths(data.body, 'body'),
          ...literalCredentialPaths(data.cookies, 'cookies'),
        ]
      : node.type === 'tool'
        ? literalCredentialPaths(data.args, 'args')
        : []
    return fields.length ? [{ nodeId: node.id, fields }] : []
  })
}
