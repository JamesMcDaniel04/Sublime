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
import type { InjectionPlan } from './types'

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

export async function resolveCredential(params: {
  credentialId: string
  organizationId: string
  userId?: string
  requestUrl: string
}): Promise<InjectionPlan> {
  const cred = await prisma.credential.findFirst({
    where: { id: params.credentialId, ...credentialScope(params.organizationId, params.userId) },
  })
  if (!cred) throw new Error(CREDENTIAL_UNAVAILABLE)
  // Domain check BEFORE decrypt: a blocked target should never cause the secret
  // to be materialised in memory at all.
  if (!isRequestUrlAllowed(params.requestUrl, cred.allowedDomains)) throw new Error(CREDENTIAL_DOMAIN_BLOCKED)

  const plan = credentialInjectionPlan(decryptCredentialConfig(cred.type, cred.authConfig))

  // Best-effort usage stamp; never block or fail the request on it.
  void prisma.credential
    .updateMany({ where: { id: cred.id, organizationId: params.organizationId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined)

  return plan
}
