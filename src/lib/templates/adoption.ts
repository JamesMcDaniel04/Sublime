/**
 * Template adoption ranking — closes the template_used loop. A deploy click
 * is a weak signal; a deployed agent/flow that is STILL ACTIVE weeks later is
 * the platform's best evidence a template produces working automation.
 *
 * Privacy: platform-wide aggregate COUNTS per template key only — no org ids,
 * user ids, names, or resource ids ever leave this module (same posture as
 * the archetype pipeline).
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cacheGet, cacheSet } from '@/lib/cache'

const WINDOW_DAYS = 90
const MAX_EVENTS = 5_000
const CACHE_KEY = 'templates:adoption-scores'
const CACHE_TTL_MS = 10 * 60 * 1000

/** deploys = template_used events; surviving = deployed resources still ACTIVE. */
export type AdoptionStat = { deploys: number; surviving: number }

/** Pure: survival dominates (working automation), raw deploys tiebreak.
 *  Weight 10 keeps one surviving deploy above any plausible burst of
 *  deploy-and-delete clicks within the window. */
export function adoptionScore(stat: AdoptionStat): number {
  return stat.surviving * 10 + stat.deploys
}

/**
 * Stable sort desc by adoption score; identity for unknown keys. Composes
 * with the other stable template sorts (applied FIRST, so readiness and
 * persona fit stay the primary keys and adoption breaks their ties).
 */
export function sortByAdoption<T>(
  items: T[],
  keyOf: (item: T) => string | null,
  scores: Record<string, AdoptionStat>,
): T[] {
  const score = (item: T) => {
    const key = keyOf(item)
    return key && scores[key] ? adoptionScore(scores[key]) : 0
  }
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}

type TemplateUseContext = { seedKey?: unknown; templateId?: unknown }

/** Pure: the ranking key a template_used event's context names. */
export function templateKeyOfContext(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null
  const { seedKey, templateId } = context as TemplateUseContext
  if (typeof seedKey === 'string' && seedKey) return `seed:${seedKey}`
  if (typeof templateId === 'string' && templateId) return `db:${templateId}`
  return null
}

/**
 * Platform-wide adoption stats keyed by template key (`seed:<seedKey>` /
 * `db:<templateId>`), cached. systemPrisma by design: the aggregation is
 * cross-org but emits only counts. Never throws — an empty map degrades the
 * catalogue to persona/readiness ordering.
 */
export async function loadTemplateAdoptionScores(db = systemPrisma): Promise<Record<string, AdoptionStat>> {
  try {
    const cached = await cacheGet<Record<string, AdoptionStat>>(CACHE_KEY)
    if (cached) return cached

    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const events = await db.userEvent.findMany({
      where: { kind: 'template_used', occurredAt: { gte: since } },
      orderBy: { occurredAt: 'desc' },
      take: MAX_EVENTS,
      select: { context: true, resourceType: true, resourceId: true },
    })

    const agentIds = new Set<string>()
    const flowIds = new Set<string>()
    for (const event of events) {
      if (!event.resourceId) continue
      if (event.resourceType === 'agent') agentIds.add(event.resourceId)
      if (event.resourceType === 'flow') flowIds.add(event.resourceId)
    }
    const [liveAgents, liveFlows] = await Promise.all([
      agentIds.size
        ? db.agentTask.findMany({ where: { id: { in: [...agentIds] }, status: 'ACTIVE' }, select: { id: true } })
        : Promise.resolve([]),
      flowIds.size
        ? db.flow.findMany({ where: { id: { in: [...flowIds] }, status: 'ACTIVE', publishedGraph: { not: undefined } }, select: { id: true } })
        : Promise.resolve([]),
    ])
    const surviving = new Set([...liveAgents.map((a) => a.id), ...liveFlows.map((f) => f.id)])

    const scores: Record<string, AdoptionStat> = {}
    for (const event of events) {
      const key = templateKeyOfContext(event.context)
      if (!key) continue
      const stat = scores[key] ?? { deploys: 0, surviving: 0 }
      stat.deploys += 1
      if (event.resourceId && surviving.has(event.resourceId)) stat.surviving += 1
      scores[key] = stat
    }

    await cacheSet(CACHE_KEY, scores, CACHE_TTL_MS)
    return scores
  } catch (error) {
    apiLogger.warn('template adoption scores unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}
