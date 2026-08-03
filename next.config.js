/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: __dirname,
  // pyodide must stay external: bundling would inline references to its
  // .wasm / python_stdlib.zip assets that only resolve from node_modules —
  // outputFileTracing carries the real files into the serverless function.
  serverExternalPackages: ['@prisma/client', 'pyodide'],
  /**
   * The goal lens moved every app surface under /g/[scope]. Permanent, because
   * these paths live in bookmarks, notification emails and Slack messages.
   *
   * Order matters: /goals/new must precede /goals/:id, or "new" is captured as
   * a goal id and the create page becomes an unresolvable lens.
   */
  async redirects() {
    return [
      { source: '/dashboard', destination: '/g/all/dashboard', permanent: true },
      { source: '/flows', destination: '/g/all/flows', permanent: true },
      { source: '/flows/:path*', destination: '/g/all/flows/:path*', permanent: true },
      { source: '/agents', destination: '/g/all/agents', permanent: true },
      { source: '/integrations', destination: '/g/all/integrations', permanent: true },
      { source: '/integrations/:path*', destination: '/g/all/integrations/:path*', permanent: true },
      { source: '/goals', destination: '/g/all/goals', permanent: true },
      { source: '/goals/new', destination: '/g/all/goals/new', permanent: true },
      // A goal deep link becomes that goal's lens, which is exactly what the
      // old detail page was.
      { source: '/goals/:id', destination: '/g/:id/goals', permanent: true },
    ]
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // microphone=(self): the flow Jam huddle (WebRTC voice) captures mic
          // audio on our own origin; a blanket microphone=() denies it at the
          // header level, which browser site settings cannot override.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // 'same-origin' severs the opener relationship for OAuth pop-ups
          // (Nango Connect, Google Sign-In), making them report "blocked".
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
