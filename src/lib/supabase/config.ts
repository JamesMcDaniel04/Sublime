/**
 * Session cookie flags, pinned rather than inherited.
 *
 * @supabase/ssr's defaults are correct today, but "correct by default" is a
 * property of the version installed, not of this application — a minor bump
 * could change it with nothing here to notice. Stating them makes them
 * reviewable and lets cookie-options.test.ts assert them.
 *
 * httpOnly is deliberately ABSENT, and that is not an oversight. @supabase/ssr
 * uses one shared cookie for both halves of the app: the server writes it, and
 * createBrowserClient (src/lib/supabase/client.ts) READS it from
 * document.cookie to hydrate the client session. Setting httpOnly makes the
 * cookie invisible to that read and signs every user out client-side. The
 * exposure it would have covered — script access to the session token — is
 * carried instead by the nonce-based CSP (src/lib/security/csp.ts), which is
 * why that policy is load-bearing rather than decorative, and by short access
 * token expiry with refresh-token reuse detection configured Supabase-side.
 *
 * Cookies we set OURSELVES and never read from JS do use httpOnly — see the
 * OAuth state cookie in src/app/api/mcp-connections/oauth/start/route.ts.
 */
export const SESSION_COOKIE_OPTIONS = {
  path: '/',
  sameSite: 'lax',
  // Never Secure on http://localhost, or the browser silently drops the cookie
  // and local development cannot hold a session at all.
  secure: process.env.NODE_ENV === 'production',
} as const

export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required')
  }

  return { url, anonKey }
}
