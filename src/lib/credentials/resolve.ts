/**
 * Resolve a credential id to an injection plan at fetch time.
 *
 * The only module in `lib/credentials` that touches the database. Enforces org
 * scope, then the per-credential domain allow-list, then decrypts. The
 * decrypted secret never leaves this function except inside the returned plan,
 * which the caller injects into the outbound request and discards.
 */
import { prisma } from '@/lib/prisma'
import { decryptCredentialConfig } from './config'
import { credentialInjectionPlan, isRequestUrlAllowed } from './plan'
import type { DecryptedCredential, InjectionPlan } from './types'

export const CREDENTIAL_UNAVAILABLE =
  'The saved credential for this step is unavailable — check it in Settings → Credentials.'
export const CREDENTIAL_DOMAIN_BLOCKED =
  'This credential is not allowed for that request URL. Add the domain to the credential’s allowed list.'

/** Org-shared rows (userId null) plus the acting user's own personal rows. */
export function credentialScope(organizationId: string, userId?: string) {
  return {
    organizationId,
    isActive: true as const,
    OR: [{ userId: null }, ...(userId ? [{ userId }] : [])],
  }
}

export type RuntimeCredentialAuth =
  | {
      type: 'digest'
      username: string
      password: string
    }
  | {
      type: 'oauth1'
      consumerKey: string
      consumerSecret: string
      accessToken: string
      tokenSecret: string
      signatureMethod: 'HMAC-SHA1' | 'HMAC-SHA256'
    }

export type ResolvedHttpCredential = {
  plan: InjectionPlan
  runtimeAuth?: RuntimeCredentialAuth
}

async function oauth2ClientCredentialPlan(
  credential: DecryptedCredential,
  deps: { fetchImpl?: typeof fetch; assertUrlAllowed?: (url: string) => Promise<void> },
): Promise<InjectionPlan> {
  const tokenUrl = credential.tokenUrl?.trim()
  const clientId = credential.clientId ?? ''
  const clientSecret = credential.clientSecret ?? ''
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error('This OAuth2 credential is incomplete. Add its token URL, client ID, and client secret.')
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
  const payload = await response.json().catch(() => null) as { access_token?: unknown; token_type?: unknown; error_description?: unknown } | null
  if (!response.ok || typeof payload?.access_token !== 'string' || !payload.access_token) {
    const reason = typeof payload?.error_description === 'string' ? `: ${payload.error_description}` : ''
    throw new Error(`OAuth2 token request failed with status ${response.status}${reason}`)
  }
  const scheme = typeof payload.token_type === 'string' && payload.token_type.trim() ? payload.token_type.trim() : 'Bearer'
  return { headers: { authorization: `${scheme} ${payload.access_token}` } }
}

export async function resolveHttpCredential(params: {
  credentialId: string
  organizationId: string
  userId?: string
  requestUrl: string
  fetchImpl?: typeof fetch
  assertUrlAllowed?: (url: string) => Promise<void>
}): Promise<ResolvedHttpCredential> {
  const cred = await prisma.credential.findFirst({
    where: { id: params.credentialId, ...credentialScope(params.organizationId, params.userId) },
  })
  if (!cred) throw new Error(CREDENTIAL_UNAVAILABLE)
  // Domain check BEFORE decrypt: a blocked target should never cause the secret
  // to be materialised in memory at all.
  if (!isRequestUrlAllowed(params.requestUrl, cred.allowedDomains)) throw new Error(CREDENTIAL_DOMAIN_BLOCKED)

  const decrypted = decryptCredentialConfig(cred.type, cred.authConfig)
  let plan = credentialInjectionPlan(decrypted)
  let runtimeAuth: RuntimeCredentialAuth | undefined
  if (decrypted.type === 'oauth2' && decrypted.grantType === 'clientCredentials') {
    plan = await oauth2ClientCredentialPlan(decrypted, params)
  } else if (decrypted.type === 'digest' && decrypted.username && decrypted.password) {
    runtimeAuth = { type: 'digest', username: decrypted.username, password: decrypted.password }
  } else if (
    decrypted.type === 'oauth1'
    && decrypted.consumerKey
    && decrypted.consumerSecret
    && decrypted.accessToken
    && decrypted.tokenSecret
  ) {
    runtimeAuth = {
      type: 'oauth1',
      consumerKey: decrypted.consumerKey,
      consumerSecret: decrypted.consumerSecret,
      accessToken: decrypted.accessToken,
      tokenSecret: decrypted.tokenSecret,
      signatureMethod: decrypted.signatureMethod ?? 'HMAC-SHA256',
    }
  }

  // Best-effort usage stamp; never block or fail the request on it.
  void prisma.credential
    .updateMany({ where: { id: cred.id, organizationId: params.organizationId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined)

  return { plan, ...(runtimeAuth ? { runtimeAuth } : {}) }
}

/** Backwards-compatible static-plan resolver used outside HTTP execution. */
export async function resolveCredential(params: {
  credentialId: string
  organizationId: string
  userId?: string
  requestUrl: string
}): Promise<InjectionPlan> {
  return (await resolveHttpCredential(params)).plan
}
