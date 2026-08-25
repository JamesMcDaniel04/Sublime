import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

async function freshEnv() {
  const mod = await import(`../env?t=${Date.now()}-${Math.random()}`)
  return mod as typeof import('../env')
}

const ORIGINAL_ENV = { ...process.env }

// Next's types mark NODE_ENV readonly; tests legitimately vary it.
function setNodeEnv(value: string) {
  Object.assign(process.env, { NODE_ENV: value })
}

const FULL_PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@h:6543/db?pgbouncer=true&connection_limit=1',
  DIRECT_URL: 'postgresql://u:p@h:5432/db',
  NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  CRON_SECRET: 'cron-secret',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  REDIS_URL: 'rediss://redis.example.com:6379',
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

test('production with everything set: does not throw', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  const { assertServerEnv } = await freshEnv()
  assert.doesNotThrow(() => assertServerEnv())
})

test('production with a short ENCRYPTION_KEY: boot fails naming the key', async () => {
  // encryptSecret accepts any non-empty string, so key strength has to be
  // enforced here — a one-character passphrase gives AES-256 no entropy to
  // work with and an offline attacker a trivial guess.
  Object.assign(process.env, FULL_PROD_ENV, { ENCRYPTION_KEY: 'short-key' })
  const { assertServerEnv } = await freshEnv()
  assert.throws(() => assertServerEnv(), /ENCRYPTION_KEY.*32/)
})

test('worker env enforces the same ENCRYPTION_KEY strength floor', async () => {
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=40',
    REDIS_URL: 'rediss://h:6379',
    ENCRYPTION_KEY: 'short-key',
    ANTHROPIC_API_KEY: 'sk-ant-x',
  })
  const { assertWorkerEnv } = await freshEnv()
  assert.throws(() => assertWorkerEnv(), /ENCRYPTION_KEY.*32/)
})

test('server env: reports missing readiness vars while optional integrations remain warnings', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  for (const name of [
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY',
    'RESEND_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'NEXT_PUBLIC_APP_URL',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_URL',
  ]) delete process.env[name]
  const warnings: string[] = []
  const { assertServerEnv } = await freshEnv()
  const { getProductReadiness } = await freshEnv()
  assert.doesNotThrow(() => assertServerEnv({ warn: (message: string) => warnings.push(message) }))
  const joined = warnings.join('\n')
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'VAPID_PUBLIC_KEY', 'NEXT_PUBLIC_APP_URL']) {
    assert.ok(joined.includes(name), `expected a warning naming ${name}`)
  }
  // No Upstash pair and no REDIS_URL: the rate limiter silently becomes
  // per-instance memory — every limit multiplies by the instance count.
  assert.ok(/health probe will fail closed/i.test(joined), 'expected a readiness warning')
  const readiness = getProductReadiness()
  assert.equal(readiness.ok, false)
  assert.deepEqual(readiness.missing.sort(), [
    'NEXT_PUBLIC_APP_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'shared rate-limit backend',
  ].sort())
})

test('server env: complete billing, app URL, and shared rate limiting are production-ready', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  const { getProductReadiness } = await freshEnv()
  assert.deepEqual(getProductReadiness(), { ok: true, missing: [] })
})

test('server env: a configured Redis backend silences the rate-limit warning', async () => {
  Object.assign(process.env, FULL_PROD_ENV, {
    STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'whsec', SUPABASE_SERVICE_ROLE_KEY: 'srk',
    RESEND_API_KEY: 're', VAPID_PUBLIC_KEY: 'vp', VAPID_PRIVATE_KEY: 'vk', NEXT_PUBLIC_APP_URL: 'https://app',
    UPSTASH_REDIS_REST_URL: 'https://r.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'tok',
    // Error reporting joined the recommended set after the 2026-08-19 audit
    // found production running with no DSN and nothing alerting on it.
    SENTRY_DSN: 'https://key@o0.ingest.sentry.io/1',
  })
  delete process.env.REDIS_URL
  const warnings: string[] = []
  const { assertServerEnv } = await freshEnv()
  assertServerEnv({ warn: (message: string) => warnings.push(message) })
  assert.equal(warnings.length, 0, `expected no warnings, got: ${warnings.join(' | ')}`)
})

test('production with missing vars: throws listing every missing name', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  delete process.env.DATABASE_URL
  delete process.env.ENCRYPTION_KEY
  const { assertServerEnv } = await freshEnv()
  assert.throws(
    () => assertServerEnv(),
    (error: Error) =>
      error.message.includes('DATABASE_URL') && error.message.includes('ENCRYPTION_KEY'),
  )
})

test('production with only QWEN_API_KEY as model key: passes', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  delete process.env.ANTHROPIC_API_KEY
  process.env.QWEN_API_KEY = 'sk-qwen-x'
  const { assertServerEnv } = await freshEnv()
  assert.doesNotThrow(() => assertServerEnv())
})

test('production with no model key: throws mentioning both options', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.QWEN_API_KEY
  const { assertServerEnv } = await freshEnv()
  assert.throws(
    () => assertServerEnv(),
    (error: Error) =>
      error.message.includes('ANTHROPIC_API_KEY') && error.message.includes('QWEN_API_KEY'),
  )
})

test('development with nothing set: does not throw (dev ergonomics)', async () => {
  setNodeEnv('development')
  for (const key of Object.keys(FULL_PROD_ENV)) {
    if (key !== 'NODE_ENV') delete process.env[key]
  }
  const { assertServerEnv } = await freshEnv()
  assert.doesNotThrow(() => assertServerEnv())
})

test('production DATABASE_URL without pgbouncer/connection_limit: throws naming both', async () => {
  Object.assign(process.env, FULL_PROD_ENV, { DATABASE_URL: 'postgresql://u:p@h:6543/db' })
  const { assertServerEnv } = await freshEnv()
  assert.throws(
    () => assertServerEnv(),
    (error: Error) => error.message.includes('pgbouncer=true') && error.message.includes('connection_limit'),
  )
})

test('production DATABASE_URL escape hatch DATABASE_URL_UNPOOLED_OK: does not throw', async () => {
  Object.assign(process.env, FULL_PROD_ENV, {
    DATABASE_URL: 'postgresql://u:p@h:5432/db',
    DATABASE_URL_UNPOOLED_OK: 'true',
  })
  const { assertServerEnv } = await freshEnv()
  assert.doesNotThrow(() => assertServerEnv())
})

test('worker env: throws on missing required, passes with them set', async () => {
  setNodeEnv('production')
  for (const key of ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY', 'ANTHROPIC_API_KEY', 'QWEN_API_KEY']) delete process.env[key]
  const { assertWorkerEnv } = await freshEnv()
  assert.throws(
    () => assertWorkerEnv(),
    (error: Error) => error.message.includes('DATABASE_URL') && error.message.includes('REDIS_URL'),
  )
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=40',
    REDIS_URL: 'rediss://h:6379',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ANTHROPIC_API_KEY: 'sk-ant-x',
  })
  const fresh = await freshEnv()
  assert.doesNotThrow(() => fresh.assertWorkerEnv())
})

test('worker env: warns (never throws) when the pool is smaller than worker concurrency', async () => {
  setNodeEnv('production')
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://u:p@h:6543/db?pgbouncer=true&connection_limit=1',
    REDIS_URL: 'rediss://h:6379',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    AGENT_WORKER_CONCURRENCY: '10',
  })
  const { assertWorkerEnv } = await freshEnv()
  const warnings: string[] = []
  assert.doesNotThrow(() => assertWorkerEnv({ warn: (msg: string) => warnings.push(msg) }))
  assert.ok(warnings.some((msg) => msg.includes('connection_limit')), `expected a pool-size warning, got: ${warnings.join(' | ')}`)
})

// ── Worker graph-RAG env ────────────────────────────────────────────────────
//
// The 2026-08-24 gap: the Fly worker ran for weeks with no NEO4J_* and no
// VOYAGE_API_KEY. Production executes agent runs on that process, so
// ragEnabled() was false for every run — nothing retrieved, nothing indexed —
// and nothing anywhere said so. These belong in RECOMMENDED (warn), never in
// REQUIRED: a worker deploy must not go down over degraded grounding.

const WORKER_BASE = {
  DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=40',
  REDIS_URL: 'rediss://h:6379',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ANTHROPIC_API_KEY: 'sk-ant-x',
}

test('worker env: warns when the graph store is unset, naming the runtime consequence', async () => {
  setNodeEnv('production')
  Object.assign(process.env, WORKER_BASE, { VOYAGE_API_KEY: 'pa-key' })
  delete process.env.NEO4J_URI
  const { assertWorkerEnv } = await freshEnv()
  const warnings: string[] = []
  assert.doesNotThrow(() => assertWorkerEnv({ warn: (msg: string) => warnings.push(msg) }))
  const found = warnings.find((msg) => msg.includes('NEO4J_URI'))
  assert.ok(found, `expected a NEO4J_URI warning, got: ${warnings.join(' | ')}`)
  assert.match(found, /ground|index/i, 'the warning must name what runs lose, not just the key')
})

// Both halves of ragEnabled() matter: a graph with no embeddings key indexes
// and retrieves exactly nothing, so its absence is equally worth a warning.
test('worker env: warns when the embeddings key is unset', async () => {
  setNodeEnv('production')
  Object.assign(process.env, WORKER_BASE, { NEO4J_URI: 'neo4j+s://h', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: 'pw' })
  delete process.env.VOYAGE_API_KEY
  const { assertWorkerEnv } = await freshEnv()
  const warnings: string[] = []
  assert.doesNotThrow(() => assertWorkerEnv({ warn: (msg: string) => warnings.push(msg) }))
  assert.ok(
    warnings.some((msg) => msg.includes('VOYAGE_API_KEY')),
    `expected a VOYAGE_API_KEY warning, got: ${warnings.join(' | ')}`,
  )
})

// A URI alone is not a configured graph: neo4jConfigured() requires all three,
// so a missing password degrades exactly as silently as a missing URI.
test('worker env: warns on partial Neo4j credentials, not just a missing URI', async () => {
  setNodeEnv('production')
  Object.assign(process.env, WORKER_BASE, { NEO4J_URI: 'neo4j+s://h', NEO4J_USERNAME: 'neo4j', VOYAGE_API_KEY: 'pa-key' })
  delete process.env.NEO4J_PASSWORD
  const { assertWorkerEnv } = await freshEnv()
  const warnings: string[] = []
  assert.doesNotThrow(() => assertWorkerEnv({ warn: (msg: string) => warnings.push(msg) }))
  assert.ok(
    warnings.some((msg) => msg.includes('NEO4J_PASSWORD')),
    `expected a NEO4J_PASSWORD warning, got: ${warnings.join(' | ')}`,
  )
})

test('worker env: a fully configured graph-RAG setup warns about neither', async () => {
  setNodeEnv('production')
  Object.assign(process.env, WORKER_BASE, {
    NEO4J_URI: 'neo4j+s://h', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: 'pw', VOYAGE_API_KEY: 'pa-key',
  })
  const { assertWorkerEnv } = await freshEnv()
  const warnings: string[] = []
  assert.doesNotThrow(() => assertWorkerEnv({ warn: (msg: string) => warnings.push(msg) }))
  assert.ok(!warnings.some((msg) => msg.includes('NEO4J_URI') || msg.includes('VOYAGE_API_KEY')))
})
