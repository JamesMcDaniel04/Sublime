/** Per-request CSP. Next reads the nonce from the request header and applies it
 * to framework and inline scripts during dynamic rendering. */
export function contentSecurityPolicy(nonce: string, development = false): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://vercel.live https://assets.vercel.com",
    "style-src 'self' 'unsafe-inline' https://vercel.live",
    // challenges.cloudflare.com: Turnstile needs BOTH a script host and a
    // frame host — the widget loads a script that renders a cross-origin
    // iframe. Omitting frame-src leaves the challenge permanently blank with
    // nothing but a console error to explain it.
    `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ''} https://vercel.live https://challenges.cloudflare.com`,
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://*.ingest.sentry.io https://vercel.live wss://ws-us3.pusher.com https://api.nango.dev wss://api.nango.dev",
    'frame-src https://vercel.live https://connect.nango.dev https://challenges.cloudflare.com',
    'upgrade-insecure-requests',
  ].join('; ')
}
