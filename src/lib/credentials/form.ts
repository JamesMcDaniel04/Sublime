/**
 * Pure form logic for the credential editor. Extracted so the interesting
 * decisions — which fields a type needs, what a save payload looks like, when a
 * secret is intentionally omitted — are unit-testable without a DOM.
 */
import type { CredentialInput, CredentialType, CustomAuthEntry, RedactedCredential } from './types'

export type CredentialField =
  | 'username'
  | 'password'
  | 'token'
  | 'headerName'
  | 'queryParam'
  | 'key'
  | 'entries'
  | 'consumerKey'
  | 'consumerSecret'
  | 'accessToken'
  | 'tokenSecret'
  | 'signatureMethod'
  | 'grantType'
  | 'tokenUrl'
  | 'clientId'
  | 'clientSecret'
  | 'scope'
  | 'audience'
  | 'clientAuth'

/** Which inputs a type shows, in display order. */
export function fieldsForType(type: CredentialType): CredentialField[] {
  switch (type) {
    case 'basic':
      return ['username', 'password']
    case 'bearer':
      return ['token']
    case 'digest':
      return ['username', 'password']
    case 'apiKeyHeader':
      return ['headerName', 'key']
    case 'apiKeyQuery':
      return ['queryParam', 'key']
    case 'custom':
      return ['entries']
    case 'oauth1':
      return ['consumerKey', 'consumerSecret', 'accessToken', 'tokenSecret', 'signatureMethod']
    case 'oauth2':
      return ['grantType', 'accessToken', 'tokenUrl', 'clientId', 'clientSecret', 'scope', 'audience', 'clientAuth']
    default:
      return []
  }
}

export const SECRET_FIELDS: ReadonlySet<CredentialField> = new Set([
  'password',
  'token',
  'key',
  'consumerSecret',
  'accessToken',
  'tokenSecret',
  'clientSecret',
])

export const TYPE_LABELS: Record<CredentialType, string> = {
  basic: 'Basic Auth',
  bearer: 'Bearer Auth',
  custom: 'Custom Auth',
  digest: 'Digest Auth',
  apiKeyHeader: 'Header Auth',
  oauth1: 'OAuth1 API',
  oauth2: 'OAuth2 API',
  apiKeyQuery: 'Query Auth',
}

export const FIELD_LABELS: Record<CredentialField, string> = {
  username: 'Username',
  password: 'Password',
  token: 'Token',
  headerName: 'Header name',
  queryParam: 'Query parameter',
  key: 'Key',
  entries: 'Headers and query parameters',
  consumerKey: 'Consumer key',
  consumerSecret: 'Consumer secret',
  accessToken: 'Access token',
  tokenSecret: 'Access token secret',
  signatureMethod: 'Signature method',
  grantType: 'Grant type',
  tokenUrl: 'Access token URL',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  scope: 'Scope',
  audience: 'Audience',
  clientAuth: 'Client authentication',
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
  caCert: string
  consumerKey: string
  consumerSecret: string
  accessToken: string
  tokenSecret: string
  signatureMethod: 'HMAC-SHA1' | 'HMAC-SHA256'
  grantType: 'staticToken' | 'clientCredentials'
  tokenUrl: string
  clientId: string
  clientSecret: string
  scope: string
  audience: string
  clientAuth: 'header' | 'body'
}

export const emptyDraft = (): CredentialDraft => ({
  name: '',
  type: 'bearer',
  personal: true,
  allowedDomains: '',
  username: '',
  password: '',
  token: '',
  headerName: '',
  queryParam: '',
  key: '',
  headers: [{ name: '', value: '' }],
  query: [{ name: '', value: '' }],
  caCert: '',
  consumerKey: '',
  consumerSecret: '',
  accessToken: '',
  tokenSecret: '',
  signatureMethod: 'HMAC-SHA256',
  grantType: 'staticToken',
  tokenUrl: '',
  clientId: '',
  clientSecret: '',
  scope: '',
  audience: '',
  clientAuth: 'header',
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
    consumerKey: row.config.consumerKey ?? '',
    signatureMethod: row.config.signatureMethod ?? 'HMAC-SHA256',
    grantType: row.config.grantType ?? 'staticToken',
    tokenUrl: row.config.tokenUrl ?? '',
    clientId: row.config.clientId ?? '',
    scope: row.config.scope ?? '',
    audience: row.config.audience ?? '',
    clientAuth: row.config.clientAuth ?? 'header',
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
    if (draft.type === 'oauth2') {
      if (draft.grantType === 'staticToken' && field !== 'grantType' && field !== 'accessToken') continue
      if (draft.grantType === 'clientCredentials' && field === 'accessToken') continue
      if ((field === 'scope' || field === 'audience') && !draft[field].trim()) continue
    }
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
  if (draft.caCert.trim()) body.caCert = draft.caCert
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
    if (draft.type === 'oauth2') {
      if (draft.grantType === 'staticToken' && field !== 'grantType' && field !== 'accessToken') continue
      if (draft.grantType === 'clientCredentials' && field === 'accessToken') continue
      if ((field === 'scope' || field === 'audience') && !draft[field].trim()) continue
    }
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
