/**
 * Pure: a decrypted credential → the header/query mutations to inject, and the
 * fail-closed egress allow-list check that gates them.
 *
 * A credential only ever contributes headers and query params. It never
 * rewrites the URL path, method, or body — so a mis-scoped credential cannot
 * redirect a request somewhere unexpected.
 */
import type { DecryptedCredential, InjectionPlan, CustomAuthEntry } from './types'

const entriesToRecord = (entries: CustomAuthEntry[] | undefined): Record<string, string> =>
  Object.fromEntries((entries ?? []).filter((entry) => entry.name.trim()).map((entry) => [entry.name, entry.value]))

/** Turn a decrypted credential into the header/query mutations to inject. */
export function credentialInjectionPlan(dec: DecryptedCredential): InjectionPlan {
  switch (dec.type) {
    case 'bearer':
      return dec.token ? { headers: { authorization: `Bearer ${dec.token}` } } : {}
    case 'oauth2':
      return dec.grantType !== 'clientCredentials' && dec.accessToken
        ? { headers: { authorization: `Bearer ${dec.accessToken}` } }
        : {}
    case 'basic': {
      const token = Buffer.from(`${dec.username ?? ''}:${dec.password ?? ''}`).toString('base64')
      return { headers: { authorization: `Basic ${token}` } }
    }
    case 'apiKeyHeader':
      return dec.headerName?.trim() && dec.key ? { headers: { [dec.headerName]: dec.key } } : {}
    case 'apiKeyQuery':
      return dec.queryParam?.trim() && dec.key ? { query: { [dec.queryParam]: dec.key } } : {}
    case 'custom': {
      const headers = entriesToRecord(dec.headers)
      const query = entriesToRecord(dec.query)
      return {
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(Object.keys(query).length ? { query } : {}),
      }
    }
    default:
      return {}
  }
}

/**
 * Canonicalize one domain supplied by a user. Schemes, paths, ports, wildcard
 * labels, and malformed DNS names are rejected so the stored value has exactly
 * one interpretation at request time.
 */
export function normalizeAllowedDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) return null
  const labels = domain.split('.')
  if (labels.some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null
  return domain
}

export function normalizeAllowedDomains(raw: string[]): string[] | null {
  const domains = raw.map(normalizeAllowedDomain)
  if (domains.some((domain) => domain === null)) return null
  return [...new Set(domains as string[])]
}

/**
 * True when the request host is covered by the allow-list. Empty lists fail
 * closed. A host matches an allowed domain when it equals it or is a subdomain
 * (`.domain`). Unparseable URLs are rejected — a credential must never be sent
 * to a target we couldn't parse well enough to check.
 */
export function isRequestUrlAllowed(requestUrl: string, allowedDomains: string[]): boolean {
  if (!allowedDomains.length) return false
  let host: string
  try {
    host = new URL(requestUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedDomains.some((raw) => {
    const domain = normalizeAllowedDomain(raw)
    return Boolean(domain && (host === domain || host.endsWith(`.${domain}`)))
  })
}
