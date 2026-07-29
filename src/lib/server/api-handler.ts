import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
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
export type RouteAccess = { requires: 'member' | Capability }

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
      const auth = await requireAuthContext()
      authFinishedAt = performance.now()

      assertCapability(auth, access)

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
