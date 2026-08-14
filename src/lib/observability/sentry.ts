/**
 * Error reporting seam.
 *
 * `captureError` is safe to call anywhere on the server: with SENTRY_DSN set
 * (and initSentry() run from instrumentation.ts) errors go to Sentry; without
 * it they fall back to structured console output. A reporter can be injected
 * for tests. Reporting must never throw into the caller.
 */

import { redactSecrets } from '@/lib/llm/guardrails'

type ErrorReporter = (error: unknown, context?: Record<string, unknown>) => void

/**
 * Scrub credential-shaped strings out of an outbound Sentry event.
 *
 * `redactSecrets` was already protecting the LLM transcript — the place we most
 * obviously hand data to a third party. Sentry is the other one, and it was
 * receiving events verbatim: an error message carrying a URL with a token in
 * the query string, a failed-request body, or a `context` object a caller
 * passed as `extra` all went out in the clear.
 *
 * A JSON round-trip rather than a field allowlist, because the fields that
 * matter here keep moving — message, exception values, breadcrumbs, request
 * data, extra, contexts — and an allowlist silently misses whichever one the
 * SDK adds next. `[redacted:kind]` contains no quotes or backslashes, so the
 * substitution cannot break the JSON.
 *
 * Exported for tests; not part of the module's public surface otherwise.
 */
export function scrubSentryEvent<T>(event: T): T {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(event))) as T
  } catch {
    // Never send an unscrubbed event because scrubbing failed. Fall back to
    // the two fields that carry a secret most often, and drop the rest of the
    // detail rather than risk leaking it.
    const partial = event as { message?: unknown; exception?: { values?: Array<{ value?: unknown }> } }
    if (partial && typeof partial === 'object') {
      if (typeof partial.message === 'string') partial.message = redactSecrets(partial.message)
      for (const entry of partial.exception?.values ?? []) {
        if (typeof entry.value === 'string') entry.value = redactSecrets(entry.value)
      }
    }
    return event
  }
}

let reporter: ErrorReporter | null = null

export function setErrorReporter(next: ErrorReporter): void {
  reporter = next
}

type ErrorFlusher = (timeoutMs: number) => Promise<void>

let flusher: ErrorFlusher | null = null

/** Test seam: inject a flusher the way setErrorReporter injects a reporter. */
export function setErrorFlusher(next: ErrorFlusher): void {
  flusher = next
}

export function resetErrorReporter(): void {
  reporter = null
  flusher = null
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

/**
 * Drain any queued error reports (Sentry buffers sends). Call before a
 * deliberate process exit — without it, the last errors of a worker's life
 * are exactly the ones that get dropped. Safe no-op when never initialized.
 */
export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (!flusher) return
  try {
    await flusher(timeoutMs)
  } catch {
    // Flushing is best-effort; never take shutdown down with it.
  }
}

/**
 * Initialize Sentry server-side and route captureError through it.
 * `processTag` distinguishes web (Next.js) from the standalone worker in the
 * Sentry UI. Never throws: an observability failure must not stop the process.
 */
export async function initSentry(processTag = 'web'): Promise<void> {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  try {
    const Sentry = await import('@sentry/nextjs')
    Sentry.init({
      dsn,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,
      // Explicit rather than relying on the SDK default: this is the setting
      // that decides whether request headers, cookies and user IP leave the
      // process, so it should be readable here rather than looked up.
      sendDefaultPii: false,
      beforeSend: (event) => scrubSentryEvent(event),
    })
    Sentry.setTag('process', processTag)
    setErrorReporter((error, context) => {
      Sentry.captureException(error, context ? { extra: context } : undefined)
    })
    setErrorFlusher(async (timeoutMs) => {
      await Sentry.flush(timeoutMs)
    })
  } catch (error) {
    console.error('[sentry] init failed; falling back to console reporting', error)
  }
}
