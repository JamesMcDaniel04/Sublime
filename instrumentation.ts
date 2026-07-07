/**
 * Next.js server instrumentation — runs once per server boot.
 * Fails fast on missing required env in production, then initializes error
 * tracking. https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertServerEnv } = await import('./src/lib/env')
    assertServerEnv()
    const { initSentry } = await import('./src/lib/observability/sentry')
    await initSentry()
  }
}
