/**
 * Error reporting seam.
 *
 * `captureError` is safe to call anywhere on the server: with SENTRY_DSN set
 * (and initSentry() run from instrumentation.ts) errors go to Sentry; without
 * it they fall back to structured console output. A reporter can be injected
 * for tests. Reporting must never throw into the caller.
 */

type ErrorReporter = (error: unknown, context?: Record<string, unknown>) => void

let reporter: ErrorReporter | null = null

export function setErrorReporter(next: ErrorReporter): void {
  reporter = next
}

export function resetErrorReporter(): void {
  reporter = null
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  try {
    if (reporter) {
      reporter(error, context)
      return
    }
    console.error('[error]', context ?? {}, error)
  } catch {
    // Reporting must never take the request down with it.
  }
}

/** Initialize Sentry server-side and route captureError through it. */
export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  const Sentry = await import('@sentry/nextjs')
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
  })
  setErrorReporter((error, context) => {
    Sentry.captureException(error, context ? { extra: context } : undefined)
  })
}
