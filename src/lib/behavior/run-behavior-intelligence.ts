/**
 * Per-org behavior-intelligence tick (spec §3/§4 cadence). For each user with
 * fresh events: daily pattern inference, then synthesis (self-throttled to
 * weekly by its atomic claim; one open suggestion per user). Never throws —
 * cron dispatch fires it best-effort.
 *
 * Emits ONE structured `behavior.metrics` log line per org per tick — the
 * "is the platform learning?" signal: users processed, patterns written, and
 * a synthesis outcome tally (created vs each skip reason). An org whose
 * accept rate collapses or whose skips are all 'error' is visible in logs
 * without touching the database.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { inferUserBehaviorPatterns } from './infer-user-patterns'
import { synthesizeUserSuggestions } from '@/lib/intelligence/suggest-user-workflows'

const FRESH_WINDOW_MS = 25 * 60 * 60 * 1000 // 25h: daily tick with slack

export type BehaviorRunStats = {
  organizationId: string
  usersProcessed: number
  patternsWritten: number
  inferenceSkips: Record<string, number>
  synthesis: Record<string, number> // 'created' | each skip reason → count
}

// systemPrisma: cron-only per-org tick (CRON_SECRET-gated); queries stay org-scoped,
// and the inference job's userId_slug upsert has no org key in its unique where.
export async function runBehaviorIntelligence(organizationId: string, db = systemPrisma): Promise<BehaviorRunStats> {
  const stats: BehaviorRunStats = {
    organizationId, usersProcessed: 0, patternsWritten: 0, inferenceSkips: {}, synthesis: {},
  }
  try {
    const since = new Date(Date.now() - FRESH_WINDOW_MS)
    const active = await db.userEvent.findMany({
      where: { organizationId, occurredAt: { gte: since } },
      select: { userId: true },
      distinct: ['userId'],
      take: 50,
    })
    for (const { userId } of active) {
      stats.usersProcessed += 1
      const inferred = await inferUserBehaviorPatterns(organizationId, userId, { db })
      if ('patterns' in inferred) stats.patternsWritten += inferred.patterns
      else stats.inferenceSkips[inferred.skipped] = (stats.inferenceSkips[inferred.skipped] ?? 0) + 1
      const synthesized = await synthesizeUserSuggestions(organizationId, userId)
      const outcome = 'created' in synthesized ? 'created' : synthesized.skipped
      stats.synthesis[outcome] = (stats.synthesis[outcome] ?? 0) + 1
    }
    if (stats.usersProcessed > 0) apiLogger.info('behavior.metrics', stats as unknown as Record<string, unknown>)
  } catch (error) {
    apiLogger.warn('behavior.runBehaviorIntelligence failed', {
      organizationId, error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { scope: 'behavior.tick', organizationId })
  }
  return stats
}
