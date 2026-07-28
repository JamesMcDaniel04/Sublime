import { after } from 'next/server'
import { apiLogger } from '@/lib/logger'

/**
 * Schedule fire-and-forget work that must outlive the response — without ever
 * being able to fail it.
 *
 * `after` is the right primitive (on serverless it keeps the function alive
 * past the response), but it THROWS when called outside a request scope. A
 * route that calls it bare turns a fully-successful write into a 500: the row
 * is committed, the response is lost, and the user retries into a duplicate.
 *
 * So: try `after`, and if the scope is unavailable, fall back to a detached
 * promise. Either way the caller's request is already done and correct.
 */
export function afterResponse(work: () => Promise<unknown>): void {
  const guarded = () => work().catch((error) => {
    apiLogger.warn('afterResponse: background work failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  try {
    after(guarded)
  } catch {
    // No request scope (a direct handler invocation, a non-serverless path).
    // Run it detached rather than losing the work AND the response.
    void guarded()
  }
}
