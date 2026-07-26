/**
 * OAuth2 client-credentials token exchange, with a process-local cache.
 *
 * Without the cache every HTTP step — and every pagination page inside one —
 * mints a fresh token, which spends provider rate limit and adds a round-trip
 * to each request.
 *
 * CACHE SAFETY. Two rules keep a cached token from outliving its authority:
 *   - the key includes every input that determines the token (client id and
 *     SECRET, token URL, scope, audience), so rotating a secret can never be
 *     answered from cache, and
 *   - `invalidateOAuth2Token` is called whenever a credential row is updated
 *     or deleted, so an edit takes effect immediately rather than after the
 *     old token happens to expire.
 * Tokens live in memory only — never logged, never persisted.
 */
import { createHash } from 'node:crypto'
import type { DecryptedCredential, InjectionPlan } from './types'

/**
 * Treat a token as expired this long before it really is, to cover clock skew
 * and the flight time of the request it is about to authorize.
 */
const EXPIRY_MARGIN_MS = 60_000

type CacheEntry = { fingerprint: string; authorization: string; expiresAt: number }

const cache = new Map<string, CacheEntry>()

/**
 * Everything that determines which token a credential gets. The secret is
 * hashed rather than stored so a rotation misses the cache without the cache
 * itself holding a second copy of the secret.
 */
function fingerprint(credential: DecryptedCredential): string {
  return createHash('sha256')
    .update(JSON.stringify([
      credential.tokenUrl ?? '',
      credential.clientId ?? '',
      credential.clientSecret ?? '',
      credential.scope ?? '',
      credential.audience ?? '',
      credential.clientAuth ?? 'header',
    ]))
    .digest('hex')
}

/** Drop a credential's cached token. Call on every update and delete. */
export function invalidateOAuth2Token(credentialId: string): void {
  cache.delete(credentialId)
}

/** Drop every cached token. */
export function resetOAuth2TokenCache(): void {
  cache.clear()
}

export async function oauth2ClientCredentialPlan(
  credentialId: string,
  credential: DecryptedCredential,
  deps: { fetchImpl?: typeof fetch; assertUrlAllowed?: (url: string) => Promise<void> } = {},
): Promise<InjectionPlan> {
  const tokenUrl = credential.tokenUrl?.trim()
  const clientId = credential.clientId ?? ''
  const clientSecret = credential.clientSecret ?? ''
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error('This OAuth2 credential is incomplete. Add its token URL, client ID, and client secret.')
  }

  const print = fingerprint(credential)
  const cached = cache.get(credentialId)
  if (cached && cached.fingerprint === print && cached.expiresAt > Date.now()) {
    return { headers: { authorization: cached.authorization } }
  }

  await deps.assertUrlAllowed?.(tokenUrl)
  const body = new URLSearchParams({ grant_type: 'client_credentials' })
  if (credential.scope?.trim()) body.set('scope', credential.scope.trim())
  if (credential.audience?.trim()) body.set('audience', credential.audience.trim())
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (credential.clientAuth === 'body') {
    body.set('client_id', clientId)
    body.set('client_secret', clientSecret)
  } else {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  }

  const response = await (deps.fetchImpl ?? fetch)(tokenUrl, { method: 'POST', headers, body })
  const payload = await response.json().catch(() => null) as
    { access_token?: unknown; token_type?: unknown; expires_in?: unknown; error_description?: unknown } | null
  if (!response.ok || typeof payload?.access_token !== 'string' || !payload.access_token) {
    const reason = typeof payload?.error_description === 'string' ? `: ${payload.error_description}` : ''
    throw new Error(`OAuth2 token request failed with status ${response.status}${reason}`)
  }
  const scheme = typeof payload.token_type === 'string' && payload.token_type.trim() ? payload.token_type.trim() : 'Bearer'
  const authorization = `${scheme} ${payload.access_token}`

  // A provider that states no lifetime gets no caching — guessing one risks
  // serving a token the provider has already revoked.
  const lifetimeMs = Number(payload.expires_in) * 1000
  if (Number.isFinite(lifetimeMs) && lifetimeMs > 0) {
    cache.set(credentialId, { fingerprint: print, authorization, expiresAt: Date.now() + lifetimeMs - EXPIRY_MARGIN_MS })
  } else {
    cache.delete(credentialId)
  }
  return { headers: { authorization } }
}
