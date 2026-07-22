import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { AuthContextError, requireAuthContext, type AuthContext } from './auth'

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

export function withAuthenticatedApi(handler: AuthenticatedHandler) {
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
