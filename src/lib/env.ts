/**
 * Central server environment validation.
 *
 * `assertServerEnv()` runs once at server startup (instrumentation.ts) and
 * throws a single aggregated error naming every missing required variable, so
 * a misconfigured deploy fails loudly at boot instead of 500ing per-request.
 *
 * `assertWorkerEnv()` is the worker-runtime equivalent (runtime.ts start()) —
 * the worker previously ran NO env validation at all, which is how it shipped
 * to production without SENTRY_DSN (all error reporting silently console-only)
 * and without VAPID keys (every push notification silently unsent).
 *
 * Required in production only — development stays permissive so a fresh clone
 * can boot without a full env file.
 */

const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'DIRECT_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'ENCRYPTION_KEY',
  // Without this, Vercel never authenticates its cron invocations, so every
  // schedule (agents, flows, wait-resumes, reapers, retention, intelligence)
  // silently never fires while still showing "active" in the UI.
  'CRON_SECRET',
] as const

/** At least one model provider key must be present for agent runs. Claude
 *  (Anthropic) is the default; Qwen is the OpenAI-compatible alternative. */
const MODEL_KEYS = ['ANTHROPIC_API_KEY', 'QWEN_API_KEY'] as const

function missingModelKey(): string | null {
  return MODEL_KEYS.some((name) => Boolean(process.env[name])) ? null : `one of ${MODEL_KEYS.join(' or ')}`
}

/**
 * encryptSecret accepts any non-empty string, so key strength is enforced at
 * boot instead: AES-256 under a key derived from a short passphrase gives an
 * offline attacker a trivial guess space, and v1 rows derive with a single
 * unsalted SHA-256.
 */
function assertEncryptionKeyStrength(): void {
  const key = process.env.ENCRYPTION_KEY
  if (key && key.length < 32) {
    throw new Error(
      'ENCRYPTION_KEY must be at least 32 characters of high-entropy material. ' +
        'Generate one with: openssl rand -hex 32 — and run scripts/rotate-encryption-key.ts to re-encrypt existing rows.',
    )
  }
}

function throwMissing(missing: string[]): never {
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}. ` +
      'Set them in the deployment environment before starting the server.',
  )
}

/**
 * Serverless Prisma MUST go through the transaction pooler with an explicit
 * per-instance connection budget. Without `pgbouncer=true` Prisma emits
 * prepared statements that break behind Supavisor's transaction mode
 * (`prepared statement "s0" already exists`); without `connection_limit` it
 * defaults to cpu*2+1 connections PER lambda instance — 40 warm instances is
 * ~360 connections against a Postgres cap in the low hundreds. This was
 * previously documented in .env.example only, with nothing enforcing it.
 *
 * Escape hatch for a deliberate direct connection (self-hosted Postgres with
 * a big max_connections): DATABASE_URL_UNPOOLED_OK=true.
 */
function assertPooledDatabaseUrl(rawUrl: string): void {
  if (process.env.DATABASE_URL_UNPOOLED_OK === 'true') return
  let params: URLSearchParams
  try {
    params = new URL(rawUrl).searchParams
  } catch {
    throw new Error('DATABASE_URL is not a parseable URL')
  }
  const problems: string[] = []
  if (params.get('pgbouncer') !== 'true') problems.push('pgbouncer=true')
  if (!params.get('connection_limit')) problems.push('connection_limit=<n>')
  if (problems.length > 0) {
    throw new Error(
      `DATABASE_URL must include ${problems.join(' and ')} for serverless (transaction pooler, bounded per-instance pool). ` +
        'See .env.example. Set DATABASE_URL_UNPOOLED_OK=true only for a deliberate direct connection.',
    )
  }
}

// Missing these degrades a product surface rather than the whole server —
// warn loudly at boot (same policy as RECOMMENDED_FOR_WORKER below) instead
// of refusing to start. The 2026-08-01 audit found every one of these was
// unasserted while production code hard-depends on it.
const RECOMMENDED_FOR_SERVER = [
  ['SUPABASE_SERVICE_ROLE_KEY', 'realtime run-event broadcasts will be off (clients fall back to polling latency)'],
  ['RESEND_API_KEY', 'the contact form 503s and digest emails are silently unsent'],
  ['VAPID_PUBLIC_KEY', 'push notifications will silently never send'],
  ['VAPID_PRIVATE_KEY', 'push notifications will silently never send'],
  ['NEXT_PUBLIC_APP_URL', 'invite/digest deep links will render without a host'],
  ['SENTRY_DSN', 'errors are unreported — captured exceptions go to console output and nothing alerts'],
] as const

const REQUIRED_FOR_PRODUCT_READINESS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_APP_URL',
] as const

/** True when SOME shared rate-limit backend is configured (Upstash REST pair
 *  or plain Redis). Without one, every limit silently becomes per-instance
 *  in-memory — a 40-instance fan-out multiplies every cap by 40. */
function rateLimitBackendConfigured(): boolean {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) return true
  return Boolean(process.env.REDIS_URL)
}

export type ProductReadiness = {
  ok: boolean
  missing: string[]
}

/**
 * Configuration required for the product to accept production traffic.
 * This is separate from startup validation so build-time Next.js workers do
 * not need runtime secrets, while readiness probes still fail closed.
 */
export function getProductReadiness(): ProductReadiness {
  if (process.env.NODE_ENV !== 'production') return { ok: true, missing: [] }

  const missing = REQUIRED_FOR_PRODUCT_READINESS.filter((name) => !process.env[name]) as string[]
  if (!rateLimitBackendConfigured()) missing.push('shared rate-limit backend')
  return { ok: missing.length === 0, missing }
}

export function assertServerEnv(logger: { warn: (message: string) => void } = console): void {
  if (process.env.NODE_ENV !== 'production') return

  const missing: string[] = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name])
  const modelKey = missingModelKey()
  if (modelKey) missing.push(modelKey)
  if (missing.length > 0) throwMissing(missing)

  assertEncryptionKeyStrength()
  assertPooledDatabaseUrl(process.env.DATABASE_URL!)

  for (const [name, consequence] of RECOMMENDED_FOR_SERVER) {
    if (!process.env[name]) logger.warn(`env: ${name} is not set — ${consequence}`)
  }
  if (!process.env.EMAIL_LINK_SECRET && !process.env.CRON_SECRET) {
    logger.warn('env: EMAIL_LINK_SECRET and CRON_SECRET are not set — marketing email is skipped because unsubscribe links cannot be signed')
  }
  const readiness = getProductReadiness()
  if (!readiness.ok) {
    logger.warn(
      `env: deployment is not ready to accept traffic; missing ${readiness.missing.join(', ')}. ` +
        'The health probe will fail closed until these are configured.',
    )
  }
}

const REQUIRED_FOR_WORKER = ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY'] as const

// Missing these degrades silently rather than fatally — warn loudly instead
// of refusing to boot, so a worker deploy never goes down over observability.
const RECOMMENDED_FOR_WORKER = [
  ['SENTRY_DSN', 'worker errors will be console-only (invisible to Sentry)'],
  ['VAPID_PUBLIC_KEY', 'push notifications for queue-executed runs will silently never send'],
  ['VAPID_PRIVATE_KEY', 'push notifications for queue-executed runs will silently never send'],
  ['NEXT_PUBLIC_APP_URL', 'digest/email deep links will render without a host'],
  ['NEXT_PUBLIC_SUPABASE_URL', 'realtime run-event broadcasts will be off (clients fall back to polling latency)'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'realtime run-event broadcasts will be off (clients fall back to polling latency)'],
] as const

export function assertWorkerEnv(logger: { warn: (message: string) => void } = console): void {
  if (process.env.NODE_ENV !== 'production') return

  const missing: string[] = REQUIRED_FOR_WORKER.filter((name) => !process.env[name])
  const modelKey = missingModelKey()
  if (modelKey) missing.push(modelKey)
  if (missing.length > 0) throwMissing(missing)

  assertEncryptionKeyStrength()

  for (const [name, consequence] of RECOMMENDED_FOR_WORKER) {
    if (!process.env[name]) logger.warn(`env: ${name} is not set — ${consequence}`)
  }

  // Pool-vs-concurrency sanity: the worker runs (2×agent + flow + backfill)
  // concurrent jobs against ONE Prisma pool. Pointing it at the serverless
  // URL (connection_limit=1) starves 20+ jobs into P2024 pool timeouts while
  // the database is perfectly healthy — the exact misconfiguration the old
  // render.yaml guidance ("share the same database URL as the web app")
  // steered operators into.
  const agent = Number(process.env.AGENT_WORKER_CONCURRENCY) || 10
  const flow = Number(process.env.FLOW_WORKER_CONCURRENCY) || agent
  const backfill = Number(process.env.BACKFILL_WORKER_CONCURRENCY) || 2
  const totalConcurrency = agent * 2 + flow + backfill
  let limit: number | null = null
  try {
    const raw = new URL(process.env.DATABASE_URL!).searchParams.get('connection_limit')
    limit = raw ? Number(raw) : null
  } catch {
    // Unparseable URL will fail at Prisma connect with its own clear error.
  }
  if (limit !== null && limit < totalConcurrency) {
    logger.warn(
      `env: DATABASE_URL connection_limit=${limit} is below the worker's total concurrency (${totalConcurrency}). ` +
        'Jobs will starve on pool acquisition (P2024). Give the worker its own URL with ' +
        `connection_limit>=${totalConcurrency} (session pooler or direct connection).`,
    )
  } else if (limit === null) {
    logger.warn(
      `env: DATABASE_URL has no connection_limit — the pg driver adapter defaults to 10, likely below the worker's total concurrency (${totalConcurrency}). ` +
        `Set connection_limit>=${totalConcurrency} on the worker's DATABASE_URL.`,
    )
  }
}
