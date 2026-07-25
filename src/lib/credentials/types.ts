/**
 * Credential vault types.
 *
 * Three views of the same credential, deliberately distinct so a secret can't
 * reach the wrong surface by accident:
 *   - `CredentialInput`      plaintext, inbound from the editor only
 *   - `RedactedCredential`   what an API response may carry (hasX booleans)
 *   - `DecryptedCredential`  server-side, transient, never persisted or returned
 */
export type CredentialType = 'basic' | 'bearer' | 'apiKeyHeader' | 'apiKeyQuery' | 'custom'

export const CREDENTIAL_TYPES: readonly CredentialType[] = ['basic', 'bearer', 'apiKeyHeader', 'apiKeyQuery', 'custom']

export interface CustomAuthEntry {
  name: string
  value: string
}

export interface CredentialInput {
  type: CredentialType
  username?: string
  password?: string
  token?: string
  headerName?: string
  queryParam?: string
  key?: string
  headers?: CustomAuthEntry[]
  query?: CustomAuthEntry[]
}

export interface DecryptedCredential {
  type: CredentialType
  username?: string
  password?: string
  token?: string
  headerName?: string
  queryParam?: string
  key?: string
  headers?: CustomAuthEntry[]
  query?: CustomAuthEntry[]
}

export interface RedactedCredential {
  type: CredentialType
  headerName?: string
  queryParam?: string
  username?: string
  hasPassword?: boolean
  hasToken?: boolean
  hasKey?: boolean
  headers?: Array<{ name: string; hasValue: boolean }>
  query?: Array<{ name: string; hasValue: boolean }>
}

/**
 * What a resolved credential contributes to an outbound request. Headers and
 * query only — a credential never rewrites the URL, method, or body.
 */
export interface InjectionPlan {
  headers?: Record<string, string>
  query?: Record<string, string>
}
