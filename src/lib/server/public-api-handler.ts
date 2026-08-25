import { NextResponse, type NextRequest } from 'next/server'
import { prisma, systemPrisma } from '@/lib/prisma'
import { rateLimit } from '@/lib/ratelimit'
import { recordSecurityEvent } from '@/lib/security/alerts'
import { authenticateApiKey, type ApiKeyRow } from '@/lib/api-keys/authenticate'
import { scopeSatisfies, type ApiScope } from '@/lib/api-keys/keys'
import { declaredBodyTooLarge, DEFAULT_MAX_BODY_BYTES } from '@/lib/server/api-handler'

/**
 * The public API's request wrapper.
 *
 * Deliberately NOT withAuthenticatedApi. That wrapper is built around a
 * browser session: a Supabase cookie, a member row, a capability, and the
 * billing gate. A machine caller has none of those. Bolting key auth into it
 * would mean every session-shaped assumption in that file needs an "unless it
 * is a key" branch, which is how authorization bugs are made.
 *
 * A key carries WORKSPACE authority scoped by its own grants — it never
 * impersonates the person who created it. So there is no role check here:
 * scopes are the whole authorization model, and they are checked against a
 * closed vocabulary the route declares.
 */

export interface PublicApiContext {
  organizationId: string
  apiKeyId: string
  scopes: string[]
  /**
   * The key's creator, used ONLY where a row needs an owning user (a run has
   * to be attributed to someone). It is provenance, never authorization: a key
   * acts with workspace authority bounded by its scopes, so it must not gain
   * or lose access because of who happened to create it.
   */
  actingUserId: string
}

type PublicHandler = (
  request: NextRequest,
  context: PublicApiContext,
  params: Record<string, string>,
) => Promise<unknown>

export interface PublicApiAccess {
  /** The single scope this route requires. */
  scope: ApiScope
  /** Requests per key per minute. Defaults to a conservative 60. */
  perMinute?: number
  maxBodyBytes?: number
}

function refuse(status: number, error: string, code: string, extra?: HeadersInit) {
  return NextResponse.json({ success: false, error, code }, { status, headers: extra })
}

/**
 * Look a key up by its public prefix.
 *
 * `systemPrisma` because this read happens BEFORE a workspace is known — the
 * tenant guard cannot scope a query whose whole purpose is to discover which
 * tenant the caller belongs to. It is a single indexed read on a unique
 * column, and every row it can return is already scoped by that prefix.
 */
async function lookupKey(prefix: string): Promise<ApiKeyRow | null> {
  const row = await systemPrisma.apiKey.findUnique({
    where: { prefix },
    select: { id: true, organizationId: true, hash: true, scopes: true, revokedAt: true, expiresAt: true, createdById: true },
  })
  return row as (ApiKeyRow & { createdById: string }) | null
}

export function withPublicApi(handler: PublicHandler, access: PublicApiAccess) {
  /**
   * The second argument is REQUIRED and shaped exactly as Next passes it.
   * Typing it optional made the route fail `next build` type-checking even
   * though every direct call in tests worked — the framework's own
   * RouteContext admits no `undefined`.
   */
  return async (
    request: NextRequest,
    routeContext: { params: Promise<Record<string, string>> },
  ): Promise<Response> => {
    if (declaredBodyTooLarge(request, access.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)) {
      return refuse(413, 'Request body is too large.', 'TOO_LARGE')
    }

    const auth = await authenticateApiKey(request.headers.get('authorization'), lookupKey)
    if (!auth.ok) {
      // Every failure reports the same thing, so working through guesses tells
      // an attacker nothing about which were once real (see authenticate.ts).
      recordSecurityEvent({
        // An existing kind, because that is exactly what this is — and it
        // already carries thresholds tuned for credential-guessing volume.
        kind: 'auth.failed',
        source: request.headers.get('x-forwarded-for') ?? 'unknown',
        detail: { path: request.nextUrl.pathname },
      })
      return refuse(401, auth.error, 'UNAUTHORIZED', { 'WWW-Authenticate': 'Bearer' })
    }

    const key = auth.key

    if (!scopeSatisfies(key.scopes, access.scope)) {
      // Named explicitly: unlike an authentication failure, telling a
      // legitimate caller which scope they are missing leaks nothing and is
      // the difference between a fixable error and a mystery.
      return refuse(403, `This API key is missing the "${access.scope}" scope.`, 'INSUFFICIENT_SCOPE')
    }

    // Per KEY, not per user or per IP: the key is the identity here, and it is
    // also the thing that gets revoked when it misbehaves.
    const limited = await rateLimit(`public-api:${key.id}`, {
      limit: access.perMinute ?? 60,
      windowMs: 60_000,
    })
    if (!limited.ok) {
      return refuse(429, 'Too many requests — please slow down.', 'RATE_LIMITED', {
        'Retry-After': String(Math.ceil((limited.retryAfterMs ?? 60_000) / 1000)),
      })
    }

    const params = routeContext?.params ? await routeContext.params : {}
    let status = 200
    try {
      const result = await handler(request, {
        organizationId: key.organizationId,
        apiKeyId: key.id,
        scopes: key.scopes,
        actingUserId: (key as ApiKeyRow & { createdById: string }).createdById,
      }, params)
      const response = result instanceof Response ? result : NextResponse.json(result)
      status = response.status
      return response
    } catch (error) {
      const known = error as { statusCode?: number; message?: string; code?: string }
      status = typeof known?.statusCode === 'number' ? known.statusCode : 500
      // A 500 says nothing about what broke: an internal message on a public,
      // machine-facing endpoint is free reconnaissance.
      return refuse(
        status,
        status === 500 ? 'Something went wrong.' : (known.message ?? 'Request failed.'),
        known.code ?? 'ERROR',
      )
    } finally {
      // Best-effort, never blocking: usage reporting must not be able to fail
      // a request that already succeeded.
      void prisma.apiKeyUsage.create({
        data: {
          apiKeyId: key.id,
          organizationId: key.organizationId,
          route: request.nextUrl.pathname,
          status,
        },
      }).catch(() => undefined)
      void systemPrisma.apiKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => undefined)
    }
  }
}
