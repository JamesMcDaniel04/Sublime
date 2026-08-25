/**
 * Routes a signed-out visitor may see — the single source of truth for both
 * the server gate (lib/supabase/middleware) and the client-side bfcache /
 * refocus guard (components/providers/supabase-provider).
 *
 * These were two hand-maintained lists that had already drifted: the client
 * copy was missing /about and /contact, so a signed-out visitor who merely
 * backgrounded and refocused a tab on a marketing page was bounced to
 * /auth/login and, after signing in, dropped back on that marketing page
 * instead of the app. It also listed '/auth-code-error', a path that does not
 * exist (the route is /auth/auth-code-error).
 *
 * The route group is the real definition — everything under src/app/(public)
 * is public by construction — but edge middleware cannot read the filesystem,
 * so the list stays explicit and public-paths.test.ts asserts it matches the
 * routes on disk. Adding a page under (public) without listing it here fails
 * the suite rather than silently locking visitors out of it.
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/about',
  '/contact',
  '/privacy',
  '/terms',
  '/auth',
  '/auth/login',
  '/auth/signin',
  '/auth/signup',
  '/auth/callback',
  '/auth/auth-code-error',
  '/auth/forgot-password',
  '/auth/update-password',
])

/**
 * The client guard's rule: the listed paths, plus anything under /auth/.
 *
 * The prefix is deliberately client-only. Middleware matches the exact set so
 * that a future /auth/* route is gated until someone consciously lists it,
 * whereas the client guard only decides whether to *hide the page and bounce*
 * — being permissive there costs nothing, and treating a real auth page as
 * protected would bounce a signed-out user off the very page they need.
 */
/**
 * Public prefixes, for pages whose path carries an id.
 *
 * `/f/` is a form-triggered flow's public submission page. It is deliberately
 * a PREFIX rather than a listed path because the flow id is in the URL, and it
 * is safe to expose because the page itself renders nothing and holds nothing:
 * every byte it shows comes from an API call authorised by the per-flow
 * trigger token, which is throttled and constant-time compared. Without a
 * valid token the page shows only "this form is not available".
 */
const PUBLIC_PREFIXES = ['/auth/', '/f/'] as const

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
