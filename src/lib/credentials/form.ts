/**
 * Pure form logic for the credential editor. Extracted so the interesting
 * decisions — which fields a type needs, what a save payload looks like, when a
 * secret is intentionally omitted — are unit-testable without a DOM.
 */
import type { CredentialInput, CredentialType, CustomAuthEntry, RedactedCredential } from './types'

export type CredentialField = 'username' | 'password' | 'token' | 'headerName' | 'queryParam' | 'key' | 'entries'

/** Which inputs a type shows, in display order. */
export function fieldsForType(type: CredentialType): CredentialField[] {
  switch (type) {
    case 'basic':
      return ['username', 'password']
    case 'bearer':
      return ['token']
    case 'apiKeyHeader':
      return ['headerName', 'key']
    case 'apiKeyQuery':
      return ['queryParam', 'key']
    case 'custom':
      return ['entries']
    default:
      return []
  }
}

export const SECRET_FIELDS: ReadonlySet<CredentialField> = new Set(['password', 'token', 'key'])

export const TYPE_LABELS: Record<CredentialType, string> = {
  basic: 'Basic auth (username + password)',
  bearer: 'Bearer token',
  apiKeyHeader: 'API key in a header',
  apiKeyQuery: 'API key in a query parameter',
  custom: 'Custom headers / query params',
}

export const FIELD_LABELS: Record<CredentialField, string> = {
  username: 'Username',
  password: 'Password',
  token: 'Token',
  headerName: 'Header name',
  queryParam: 'Query parameter',
  key: 'Key',
  entries: 'Headers and query parameters',
}

export type CredentialDraft = {
  name: string
  type: CredentialType
  personal: boolean
  allowedDomains: string
  username: string
  password: string
  token: string
  headerName: string
  queryParam: string
  key: string
  headers: CustomAuthEntry[]
  query: CustomAuthEntry[]
}

export const emptyDraft = (): CredentialDraft => ({
  name: '',
  type: 'bearer',
  personal: false,
  allowedDomains: '',
  username: '',
  password: '',
  token: '',
  headerName: '',
  queryParam: '',
  key: '',
  headers: [{ name: '', value: '' }],
  query: [{ name: '', value: '' }],
})

/**
 * Seed the editor from a REDACTED credential. Secret inputs start blank by
 * construction — a redacted credential carries no values to prefill, and a
 * blank secret on save means "keep the stored one".
 */
export function draftFromRedacted(row: {
  name: string
  type: string
  personal: boolean
  allowedDomains: string[]
  config: RedactedCredential
}): CredentialDraft {
  return {
    ...emptyDraft(),
    name: row.name,
    type: row.type as CredentialType,
    personal: row.personal,
    allowedDomains: row.allowedDomains.join(', '),
    username: row.config.username ?? '',
    headerName: row.config.headerName ?? '',
    queryParam: row.config.queryParam ?? '',
    headers: row.config.headers?.length
      ? row.config.headers.map((entry) => ({ name: entry.name, value: '' }))
      : [{ name: '', value: '' }],
    query: row.config.query?.length
      ? row.config.query.map((entry) => ({ name: entry.name, value: '' }))
      : [{ name: '', value: '' }],
  }
}

export function parseAllowedDomains(value: string): string[] {
  return value
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean)
}

/** What the editor can't submit yet, in plain language. Empty = ready. */
export function draftProblems(draft: CredentialDraft, editing: boolean): string[] {
  const problems: string[] = []
  if (!draft.name.trim()) problems.push('Give this credential a name.')
  for (const field of fieldsForType(draft.type)) {
    if (field === 'entries') {
      const named = [...draft.headers, ...draft.query].filter((entry) => entry.name.trim())
      if (named.length === 0) problems.push('Add at least one header or query parameter.')
      continue
    }
    // A secret may be blank when editing — that means "keep the stored one".
    if (SECRET_FIELDS.has(field) && editing) continue
    if (!String(draft[field] ?? '').trim()) problems.push(`${FIELD_LABELS[field]} is required.`)
  }
  return problems
}

/**
 * Build the POST/PUT body. Blank secret fields are OMITTED rather than sent as
 * '' — the merge on the server preserves an omitted secret, so sending '' would
 * silently erase a working credential.
 */
export function saveBody(draft: CredentialDraft, editing: boolean): CredentialInput & Record<string, unknown> {
  const body: CredentialInput & Record<string, unknown> = {
    name: draft.name.trim(),
    type: draft.type,
    personal: draft.personal,
    allowedDomains: parseAllowedDomains(draft.allowedDomains),
  }
  const put = (field: CredentialField, value: string) => {
    const trimmed = value.trim()
    if (SECRET_FIELDS.has(field)) {
      // Never send a blank secret: on create it would store an empty
      // credential, on edit it would wipe the stored one.
      if (trimmed) body[field] = value
      return
    }
    if (trimmed || !editing) body[field] = value
  }
  for (const field of fieldsForType(draft.type)) {
    if (field === 'entries') {
      const keep = (entries: CustomAuthEntry[]) => entries.filter((entry) => entry.name.trim() && entry.value.trim())
      const headers = keep(draft.headers)
      const query = keep(draft.query)
      if (headers.length) body.headers = headers
      if (query.length) body.query = query
      continue
    }
    put(field, String(draft[field] ?? ''))
  }
  return body
}
