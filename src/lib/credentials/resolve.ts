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
import { oauth2ClientCredentialPlan } from './oauth2'
import { credentialInjectionPlan, isRequestUrlAllowed } from './plan'
import type { InjectionPlan } from './types'

export const CREDENTIAL_UNAVAILABLE =
  'The saved credential for this step is unavailable — check it in Settings → Credentials.'
export const CREDENTIAL_DOMAIN_BLOCKED =
  'This credential is not allowed for that request URL. Add the domain to the credential’s allowed list.'

/** Credentials are always owned by the acting user, even inside a shared org. */
export function credentialScope(organizationId: string, userId?: string) {
  return {
    organizationId,
    isActive: true as const,
    // A missing actor must never fall back to legacy NULL/shared rows.
    userId: userId ?? '__credential_actor_required__',
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
    plan = await oauth2ClientCredentialPlan(cred.id, decrypted, params)
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
