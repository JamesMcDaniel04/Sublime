const DEFAULT_RETRY_DELAY_MS = 500

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Thrown by withTimeout so callers can tell a timeout from a hard failure. */
export class FlowTimeoutError extends Error {}

export function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504
}

export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? String((error as Error & { code?: unknown }).code ?? '') : ''
  return error.name === 'AbortError'
    || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
    || /fetch failed|network error|socket hang up/i.test(error.message)
}

/**
 * Retry-after-TIMEOUT policy per step kind (hard errors always retry up to
 * `retries`). Agent and tool timeouts merely ABANDON the in-flight call —
 * Promise.race / withTimeout cannot cancel it — so the first execution may
 * still be running; retrying would spawn a second concurrent execution
 * (double token spend, duplicate side effects). HTTP timeouts abort the
 * request itself (AbortController), so retrying them cannot stack live work.
 */
export function shouldRetryAfterTimeout(kind: 'agent' | 'tool' | 'http'): boolean {
  return kind === 'http'
}

export function flowActionRetries(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(5, Math.round(value)))
    : 0
}

export function flowActionTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1000, Math.min(120000, Math.round(value)))
    : undefined
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number | undefined, timeoutMessage: string): Promise<T> {
  if (!timeoutMs) return operation
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FlowTimeoutError(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runWithRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    retries?: number
    timeoutMs?: number
    timeoutMessage?: string
    retryDelayMs?: number
    // When false, a timeout is terminal: withTimeout only abandons the live
    // operation, so retrying could run it a second time concurrently. Hard
    // errors still retry. Defaults to true (existing behavior) — pass
    // shouldRetryAfterTimeout(kind) to apply the per-step-kind policy.
    retryOnTimeout?: boolean
    /** Retry classifier. Unknown errors are only retried when this callback
     * explicitly permits them; omit it to preserve the generic helper's
     * backwards-compatible retry-all behavior. */
    shouldRetry?: (error: unknown, attempt: number) => boolean
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<T> {
  const retries = flowActionRetries(options.retries)
  const timeoutMs = flowActionTimeoutMs(options.timeoutMs)
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(
        operation(attempt),
        timeoutMs,
        options.timeoutMessage ?? `Step timed out after ${timeoutMs}ms`,
      )
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      if (error instanceof FlowTimeoutError && options.retryOnTimeout === false) break
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) break
      const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
      const retryAfter = error && typeof error === 'object' && 'retryAfterMs' in error
        ? Number((error as { retryAfterMs?: unknown }).retryAfterMs)
        : 0
      const delay = Math.min(60_000, Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, baseDelay * (2 ** attempt)))
      await (options.sleep ?? sleep)(delay)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
