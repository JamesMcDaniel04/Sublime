/**
 * Subsystems running in a fallback mode instead of the one the product assumes.
 *
 * These are the failures that do not raise anything: the app serves 200s, the
 * test suite is green, and a feature is quietly absent or a ceiling quietly
 * stops holding. The 2026-08-19 audit found three of them live in production at
 * once — no email provider, no error reporting, and a pool ceiling that had
 * silently stopped applying — none of which any check reported.
 *
 * Pure over its inputs so the list is testable and can be rendered anywhere:
 * the authenticated system route, boot logs, or an ops page.
 */

export type Degradation = {
  /** The variable or subsystem to fix. */
  key: string
  /** What a user loses while it stays this way. */
  impact: string
}

type Env = Record<string, string | undefined>

/** True when SOME shared cache/rate-limit backend is configured. Mirrors
 *  rateLimitBackendConfigured() in lib/env.ts. */
function cacheConfigured(env: Env): boolean {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return true
  return Boolean(env.REDIS_URL)
}

/** True when graph-RAG would actually run. Mirrors ragEnabled() in
 *  lib/rag/get-store.ts: embeddingsConfigured() AND neo4jConfigured(), the
 *  latter requiring all three vars — two of three is not a partial graph, it
 *  is a silent fall back to the per-process in-memory store. */
function graphRagConfigured(env: Env): boolean {
  const graph = Boolean(env.NEO4J_URI && env.NEO4J_USERNAME && env.NEO4J_PASSWORD)
  return graph && Boolean(env.VOYAGE_API_KEY)
}

export function degradedSubsystems(
  env: Env,
  probes: { cacheReachable?: boolean; neo4jReachable?: boolean } = {},
): Degradation[] {
  const degraded: Degradation[] = []

  if (!env.RESEND_API_KEY) {
    degraded.push({
      key: 'RESEND_API_KEY',
      impact:
        'The public contact form returns 503, digest emails are never sent, and the Email tool is withheld from every agent — so an agent asked to email a report silently cannot.',
    })
  }

  if (!env.SENTRY_DSN) {
    degraded.push({
      key: 'SENTRY_DSN',
      impact:
        'Errors are unreported: captured exceptions resolve to console output and nothing alerts, so an outage is only found by someone looking at the screen.',
    })
  }

  // Configured is not the same as working. Either state collapses the shared
  // counter into a per-process map, so monthly credit ceilings and rate limits
  // silently multiply by the number of running instances.
  if (!cacheConfigured(env) || probes.cacheReachable === false) {
    degraded.push({
      key: 'cache',
      impact:
        'The shared cache is unavailable, so monthly credit ceilings and rate limits fall back to per-instance counters and stop holding workspace-wide.',
    })
  }

  // Graph-RAG fails the same way the cache does — quietly, and on the path
  // that matters least visibly. On 2026-08-24 the queue worker carried neither
  // NEO4J_* nor VOYAGE_API_KEY, so ragEnabled() was false for every
  // queue-executed run: retrieveContext() returned nothing and
  // indexExecution() no-opped, for weeks, with /health reporting ok.
  if (!graphRagConfigured(env) || probes.neo4jReachable === false) {
    degraded.push({
      key: 'graph-rag',
      impact:
        'Agent runs execute with no graph grounding and are never indexed back, so the workspace graph stops growing and answers lose the correlated context the product promises.',
    })
  }

  return degraded
}
