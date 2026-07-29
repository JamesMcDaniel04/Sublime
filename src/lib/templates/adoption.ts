/**
 * Template adoption ranking — closes the template_used loop. A deploy click
 * is a weak signal; a deployed agent/flow that is STILL ACTIVE weeks later is
 * the platform's best evidence a template produces working automation.
 *
 * Privacy: platform-wide aggregate COUNTS per template key only — no org ids,
 * user ids, names, or resource ids ever leave this module (same posture as
 * the archetype pipeline). The counts are produced by the k-anonymous daily
 * sweep in ./aggregate-adoption; this module only reads them, so no un-floored
 * cross-org ledger scan can reach the request path.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

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
 * `db:<templateId>`), read from the k-anonymous aggregate that the daily
 * sweep maintains. Every stored row is already at or above
 * MIN_ADOPTION_ORGS, so no floor check is needed here — the invariant is
 * enforced at the write boundary.
 *
 * No cache: the table is small, indexed by primary key, and refreshed once a
 * day, so a cache would add staleness on top of staleness for nothing.
 *
 * Never throws — an empty map degrades the catalogue to persona/readiness
 * ordering, which is exactly the pre-aggregate behaviour.
 */
export async function loadTemplateAdoptionScores(db = systemPrisma): Promise<Record<string, AdoptionStat>> {
  try {
    const rows = await db.templateAdoption.findMany({
      select: { templateKey: true, deploys: true, surviving: true },
    })
    const scores: Record<string, AdoptionStat> = {}
    for (const row of rows) {
      scores[row.templateKey] = { deploys: row.deploys, surviving: row.surviving }
    }
    return scores
  } catch (error) {
    apiLogger.warn('template adoption scores unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}
