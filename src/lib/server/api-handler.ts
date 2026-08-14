import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { rateLimit } from '@/lib/ratelimit'
import { AuthContextError, requireAuthContext, type AuthContext } from './auth'
import { denialReason, type Capability } from './permissions'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'BAD_REQUEST',
    // The underlying error (when this ApiError wraps a caught failure), so 5xx
    // handling can log/report the real cause instead of the generic message.
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type AuthenticatedHandler = (
  request: NextRequest,
  auth: AuthContext,
) => Promise<Response | Record<string, unknown>>

/**
 * What a route requires beyond a valid session.
 *
 * `'member'` — any authenticated member of the workspace. The common case, but
 * it must be TYPED: the argument is mandatory, so a new route cannot inherit
 * permissiveness by simply not thinking about it. That mandatory-ness is the
 * whole point; making it optional would restore the failure mode this replaced.
 *
 * Routes that authenticate by some OTHER mechanism (Stripe signature, cron
 * secret, OAuth state, trigger token) do not use this wrapper at all and are
 * listed in src/app/api/__tests__/route-permissions.test.ts.
 */
export type RouteAccess = {
  requires: 'member' | Capability
  /**
   * Declarative per-route rate limit, enforced after auth. Two dimensions:
   * per-user (a single account looping a request) and per-org (a 50-seat org
   * multiplying every per-user limit by 50 — the org cap bounds aggregate
   * spend on expensive routes). perOrg defaults to 10× perUser; window
   * defaults to 60s. The limiter deliberately fails OPEN on a Redis outage —
   * availability over enforcement — which is why expensive routes also keep
   * their token-budget checks.
   */
  rateLimit?: {
    feature: string
    perUser: number
    perOrg?: number
    windowSeconds?: number
  }
  /**
   * Largest request body this route accepts, in bytes. Defaults to
   * DEFAULT_MAX_BODY_BYTES.
   *
   * Next's App Router applies no body limit to route handlers, so before this
   * the only ceiling was Vercel's 4.5 MB platform cap — and nothing at all on
   * the worker. Routes that legitimately receive more (file uploads, flow
   * imports) raise it explicitly, which keeps the large surfaces countable
   * instead of making the default generous enough to cover them.
   */
  maxBodyBytes?: number
}

/**
 * One megabyte. Every JSON route in this codebase is far below it — the
 * largest legitimate payloads are a 300 KB inline avatar and a 100 KB CA
 * certificate.
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/**
 * Whether a request DECLARES more than the budget.
 *
 * Content-Length is the client's claim, so this is not a hard ceiling — a
 * chunked or lying request slips past it. It is the cheap check that rejects
 * the honest-but-oversized case for one header read, before auth does a
 * Supabase round-trip on a body we were never going to accept. The real
 * ceiling stays the platform's.
 */
export function declaredBodyTooLarge(request: NextRequest, maxBytes: number): boolean {
  const declared = Number(request.headers.get('content-length') ?? '')
  return Number.isFinite(declared) && declared > maxBytes
}

async function checkRouteRateLimit(
  auth: AuthContext,
  config: NonNullable<RouteAccess['rateLimit']>,
): Promise<{ retryAfterMs: number } | null> {
  const { feature, perUser, perOrg = perUser * 10, windowSeconds = 60 } = config
  const windowMs = windowSeconds * 1000
  const [user, org] = await Promise.all([
    rateLimit(`${feature}:user:${auth.dbUser.id}`, { limit: perUser, windowMs }),
    rateLimit(`${feature}:org:${auth.organizationId}`, { limit: perOrg, windowMs }),
  ])
  const limited = [user, org].find((result) => !result.ok)
  return limited ? { retryAfterMs: limited.retryAfterMs ?? windowMs } : null
}

/**
 * Throws unless the actor holds what the route declared.
 *
 * Uses denialReason() rather than can() so the message names the ACTUAL
 * blocker — an admin refused for want of a higher tier must not be told they
 * need to be an admin, and a member refused for want of the role must not be
 * sent to the billing page.
 */
function assertCapability(auth: AuthContext, access: RouteAccess): void {
  if (access.requires === 'member') return
  const denied = denialReason(auth.actor, access.requires)
  if (denied === 'plan') {
    throw new AuthContextError('Your plan does not include this. Upgrade in Settings → Billing.', 403, 'PLAN_LIMIT')
  }
  if (denied === 'role') {
    throw new AuthContextError('Admin access required', 403, 'FORBIDDEN')
  }
}

export function withAuthenticatedApi(handler: AuthenticatedHandler, access: RouteAccess) {
  return async (request: NextRequest): Promise<Response> => {
    const startedAt = performance.now()
    let authFinishedAt = startedAt
    const withTiming = (response: Response): Response => {
      const finishedAt = performance.now()
      try {
        response.headers.set(
          'Server-Timing',
          `auth;dur=${Math.max(0, authFinishedAt - startedAt).toFixed(1)}, handler;dur=${Math.max(0, finishedAt - authFinishedAt).toFixed(1)}, total;dur=${Math.max(0, finishedAt - startedAt).toFixed(1)}`,
        )
      } catch {
        // A handler may return a response with an immutable header guard. The
        // request must still succeed; timing is diagnostic, never functional.
      }
      return response
    }
    try {
      // Before auth on purpose: rejecting an oversized body costs one header
      // read, whereas requireAuthContext() is a Supabase round-trip we would
      // be spending on a request we are about to refuse anyway.
      if (declaredBodyTooLarge(request, access.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)) {
        authFinishedAt = performance.now()
        return withTiming(NextResponse.json(
          { success: false, error: 'Request body is too large.', code: 'TOO_LARGE' },
          { status: 413 },
        ))
      }

      const auth = await requireAuthContext()
      authFinishedAt = performance.now()

      assertCapability(auth, access)

      if (access.rateLimit) {
        const limited = await checkRouteRateLimit(auth, access.rateLimit)
        if (limited) {
          return withTiming(NextResponse.json(
            { success: false, error: 'Too many requests — please slow down.', code: 'RATE_LIMITED' },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.retryAfterMs / 1000)) } },
          ))
        }
      }

      const result = await handler(request, auth)

      return withTiming(result instanceof Response ? result : NextResponse.json(result))
    } catch (error) {
      if (authFinishedAt === startedAt) authFinishedAt = performance.now()
      if (error instanceof AuthContextError) {
        return withTiming(NextResponse.json(
          { success: false, error: error.message, code: error.code },
          { status: error.status },
        ))
      }

      if (error instanceof ApiError) {
        // Server-side ApiErrors (5xx) are real failures — log + report them.
        // Client errors (4xx) are expected and returned quietly.
        if (error.status >= 500) {
          apiLogger.error('API request failed (ApiError)', {
            path: request.nextUrl.pathname,
            code: error.code,
            status: error.status,
            error: error.message,
            cause: error.cause instanceof Error ? error.cause.message : error.cause ? String(error.cause) : undefined,
          })
          captureError(error.cause ?? error, { path: request.nextUrl.pathname, code: error.code })
        }
        return withTiming(NextResponse.json(
          { success: false, error: error.message, code: error.code },
          { status: error.status },
        ))
      }

      if (error instanceof ZodError) {
        return withTiming(NextResponse.json(
          { success: false, error: 'Invalid request', code: 'VALIDATION_ERROR', issues: error.issues },
          { status: 400 },
        ))
      }

      // A malformed/empty JSON body throws SyntaxError from request.json()
      // before any handler logic runs — that's the caller's error (400), not
      // an internal failure, and must not page Sentry.
      if (error instanceof SyntaxError) {
        return withTiming(NextResponse.json(
          { success: false, error: 'Request body must be valid JSON', code: 'INVALID_JSON' },
          { status: 400 },
        ))
      }

      apiLogger.error('API request failed', {
        path: request.nextUrl.pathname,
        error: error instanceof Error ? error.message : String(error),
      })
      captureError(error, { path: request.nextUrl.pathname })

      return withTiming(NextResponse.json(
        { success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' },
        { status: 500 },
      ))
    }
  }
}
