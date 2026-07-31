import { Nango } from '@nangohq/node'

/**
 * Creates a configured Nango backend client using env vars.
 * Required env vars:
 *  - NANGO_SECRET_KEY (environment secret key from the Nango dashboard)
 * Optional env vars:
 *  - NANGO_HOST (self-hosted / regional API host; defaults to Nango Cloud)
 *
 * Env vars are read at call time (never at module load) so the Next.js build
 * succeeds even when they are not set. The instance is cached per key — the
 * SDK is stateless HTTP, and constructing a fresh axios stack per call threw
 * away connection reuse on every hot path.
 */
let cachedClient: { key: string; client: Nango } | null = null

export function getNangoClient(): Nango {
  const secretKey = process.env.NANGO_SECRET_KEY
  if (!secretKey) {
    throw new Error('Nango is not configured. Please set NANGO_SECRET_KEY')
  }
  const host = process.env.NANGO_HOST
  const cacheKey = `${secretKey}:${host ?? ''}`
  if (cachedClient?.key !== cacheKey) {
    cachedClient = { key: cacheKey, client: new Nango({ secretKey, ...(host ? { host } : {}) }) }
  }
  return cachedClient.client
}

export function nangoConfigured(): boolean {
  return Boolean(process.env.NANGO_SECRET_KEY)
}

/**
 * Deadline for Nango SDK calls, which carry NO timeout of their own (axios
 * default: none) — a Nango incident otherwise hangs the integrations page,
 * OAuth connect, and (worst) an agent tool call holding a worker slot until
 * the platform kills the function. Promise.race, so the underlying request is
 * not aborted — "timed out" means "stop waiting", not "did not happen"; treat
 * write-shaped calls accordingly.
 */
export const NANGO_DEADLINE_MS = 15_000

export function nangoDeadline<T>(promise: Promise<T>, ms = NANGO_DEADLINE_MS, label = 'nango call'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/**
 * Tag written onto every connect session so connections can be listed and
 * authorized per organization.
 */
export const NANGO_ORG_TAG = 'org_id'
