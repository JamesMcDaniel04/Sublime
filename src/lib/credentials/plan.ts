/**
 * Pure: a decrypted credential → the header/query mutations to inject, and the
 * egress allow-list check that gates them.
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
 * True when the request host is covered by the allow-list. Empty list = any
 * host. A host matches an allowed domain when it equals it or is a subdomain
 * (`.domain`). Unparseable URLs are rejected — a credential must never be sent
 * to a target we couldn't parse well enough to check.
 */
export function isRequestUrlAllowed(requestUrl: string, allowedDomains: string[]): boolean {
  if (!allowedDomains.length) return true
  let host: string
  try {
    host = new URL(requestUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedDomains.some((raw) => {
    const domain = raw.trim().toLowerCase().replace(/^\.+/, '')
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`))
  })
}
