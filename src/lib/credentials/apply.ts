/**
 * Pure: apply an injection plan to an outbound request.
 *
 * PRECEDENCE — a user-supplied value always wins. A credential fills a header
 * or query key only when the request carries no non-empty value for it, which
 * mirrors `withBearerAuthorization` in features/flows/http. Otherwise attaching
 * a saved credential could silently override an Authorization header the user
 * deliberately typed.
 */
import type { InjectionPlan } from './types'

const hasNonEmpty = (headers: Record<string, string>, key: string) =>
  Object.entries(headers).some(([name, value]) => name.toLowerCase() === key.toLowerCase() && value.trim() !== '')

export function applyCredentialPlan(
  url: string,
  headers: Record<string, string>,
  plan: InjectionPlan,
): { url: string; headers: Record<string, string> } {
  const nextHeaders = { ...headers }
  for (const [key, value] of Object.entries(plan.headers ?? {})) {
    if (!hasNonEmpty(nextHeaders, key)) nextHeaders[key] = value
  }

  let nextUrl = url
  if (plan.query && Object.keys(plan.query).length) {
    try {
      const parsed = new URL(url)
      for (const [key, value] of Object.entries(plan.query)) {
        if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value)
      }
      nextUrl = parsed.toString()
    } catch {
      // Unparseable URL: leave it alone. resolveCredential already validated
      // the host, and the fetch itself will surface the real problem.
    }
  }
  return { url: nextUrl, headers: nextHeaders }
}
