/**
 * Per-org behavior-intelligence tick (spec §3/§4 cadence). For each user with
 * fresh events: daily pattern inference, then synthesis (self-throttled to
 * weekly by its atomic claim; one open suggestion per user). Never throws —
 * cron dispatch fires it best-effort.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { inferUserBehaviorPatterns } from './infer-user-patterns'
import { synthesizeUserSuggestions } from '@/lib/intelligence/suggest-user-workflows'

const FRESH_WINDOW_MS = 25 * 60 * 60 * 1000 // 25h: daily tick with slack

// systemPrisma: cron-only per-org tick (CRON_SECRET-gated); queries stay org-scoped.
export async function runBehaviorIntelligence(organizationId: string, db = systemPrisma): Promise<void> {
  try {
    const since = new Date(Date.now() - FRESH_WINDOW_MS)
    const active = await db.userEvent.findMany({
      where: { organizationId, occurredAt: { gte: since } },
      select: { userId: true },
      distinct: ['userId'],
      take: 50,
    })
    for (const { userId } of active) {
      await inferUserBehaviorPatterns(organizationId, userId, { db })
      await synthesizeUserSuggestions(organizationId, userId)
    }
  } catch (error) {
    apiLogger.warn('behavior.runBehaviorIntelligence failed', {
      organizationId, error: error instanceof Error ? error.message : String(error),
    })
  }
}
