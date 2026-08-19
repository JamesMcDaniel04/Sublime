import type { PoolConfig } from 'pg'

/**
 * Translate `connection_limit` from DATABASE_URL into a node-postgres pool bound.
 *
 * WHY THIS EXISTS: `connection_limit` is a PRISMA parameter. Until Prisma 7 the
 * Rust query engine read it and sized its own pool. Prisma 7 hands pooling to
 * node-postgres via @prisma/adapter-pg, and node-postgres does not know the
 * parameter — it silently keeps its default `max: 10` no matter what the URL
 * says.
 *
 * That turned the deployment's entire pooling contract into a no-op while
 * leaving it apparently configured: src/lib/env.ts still REQUIRES
 * connection_limit and still asserts the worker's limit covers its concurrency,
 * so the checks pass and nothing warns. Serverless asks for 1 connection per
 * instance and quietly takes up to 10, which exhausts a Supavisor transaction
 * pool once more than a couple of instances are warm — every query then fails
 * with `(ECHECKOUTTIMEOUT) unable to check out connection from the pool`.
 *
 * Restoring the parameter's meaning (rather than hardcoding a number) keeps the
 * control surface where the deployment already puts it: the worker raises the
 * limit for its job concurrency, serverless pins it to 1, and env.ts's
 * assertions describe reality again.
 */
export function poolConfigFromDatabaseUrl(databaseUrl: string | undefined): PoolConfig {
  const config: PoolConfig = { connectionString: databaseUrl }
  const limit = connectionLimitOf(databaseUrl)
  // Left unset rather than defaulted: an absent limit is already reported by
  // assertEnv, and inventing a bound here would starve a high-concurrency
  // worker into P2024 pool timeouts instead.
  if (limit !== undefined) config.max = limit
  return config
}

function connectionLimitOf(databaseUrl: string | undefined): number | undefined {
  if (!databaseUrl) return undefined
  let raw: string | null
  try {
    raw = new URL(databaseUrl).searchParams.get('connection_limit')
  } catch {
    // A malformed URL is a config problem for assertEnv to report; throwing
    // here would crash on the first query instead.
    return undefined
  }
  if (raw === null || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
