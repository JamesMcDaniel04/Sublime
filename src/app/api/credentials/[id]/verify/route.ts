import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { resolveHttpCredential } from '@/lib/credentials/resolve'
import { applyCredentialPlan } from '@/lib/credentials/apply'
import { credentialVerificationKey } from '@/lib/connections/verification'
import { recordVerification } from '@/lib/connections/record-verification'
import { performHttpRequest, prepareHttpRequest } from '@/features/flows/http'

export const runtime = 'nodejs'

const inputSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'HEAD', 'OPTIONS']).default('GET'),
})

const idFrom = (pathname: string) => pathname.split('/').at(-2)

/**
 * Prove a reusable HTTP credential against a caller-selected safe read URL.
 * The response body is deliberately discarded: this endpoint is a credential
 * check, not a second request runner or a way to leak remote data.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`verify-http-credential:${auth.dbUser.id}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many credential checks — slow down.', 429, 'RATE_LIMITED')
  const credentialId = idFrom(request.nextUrl.pathname)
  if (!credentialId) throw new ApiError('Credential id is required')
  const input = inputSchema.parse(await request.json().catch(() => ({})))
  const verificationKey = credentialVerificationKey(credentialId)

  try {
    await assertPublicUrl(input.url)
    const prepared = prepareHttpRequest({
      method: input.method,
      url: input.url,
      failOnHttpError: true,
      responseType: 'text',
      timeoutMs: 15_000,
      // Plenty of APIs answer a bare GET with a 301/302 (http→https, trailing
      // slash, regional host). Without this the hop reads as "redirect
      // blocked" and a perfectly good credential is reported as failed. Every
      // hop is re-checked by assertUrlAllowed below.
      followRedirects: true,
      maxRedirects: 3,
    })
    const resolved = await resolveHttpCredential({
      credentialId,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      requestUrl: prepared.url,
      assertUrlAllowed: assertPublicUrl,
    })
    const applied = applyCredentialPlan(
      prepared.url,
      prepared.init.headers as Record<string, string>,
      resolved.plan,
    )
    prepared.url = applied.url
    prepared.init.headers = applied.headers
    prepared.runtimeAuth = resolved.runtimeAuth
    prepared.credentialHeaders = Object.keys(resolved.plan.headers ?? {})
    const result = await performHttpRequest(prepared, {}, {
      assertUrlAllowed: assertPublicUrl,
      maxResponseChars: 1,
    })
    const status = 'status' in result ? result.status : 200
    await recordVerification({
      organizationId: auth.organizationId,
      connectionId: verificationKey,
      state: 'verified',
    })
    return { success: true, verification: { state: 'verified', checkedAt: new Date().toISOString() }, status }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Credential verification failed.'
    await recordVerification({
      organizationId: auth.organizationId,
      connectionId: verificationKey,
      state: 'failed',
      error: message,
    })
    throw new ApiError(message, 400, 'CREDENTIAL_VERIFICATION_FAILED')
  }
})
