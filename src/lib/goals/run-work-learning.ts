/**
 * Per-org weekly learning tick. Reads settled work, earns targeting rules,
 * promotes repeats to the seed level, retires rules the probes contradict,
 * and proposes a cadence change when skips have no structure at all.
 *
 * Never throws — cron dispatch fires it best-effort, and a learning failure
 * must not break the tick that also drives goal refresh.
 *
 * systemPrisma by default: a cross-tenant cron sweep, CRON_SECRET-gated at the
 * route, with every query explicitly org-scoped.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { findRuleCandidates, type WorkObservation } from './work-signals'
import { rulesToPromote, rulesToRetire, EXPLORE_RATE, type ExistingRule, type ProbeTally } from './work-rules'
import { shouldProposeCadenceChange } from './cadence-proposal'
import type { Disposition } from './work-transitions'

export const EVIDENCE_WINDOW_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000
/** Separator that cannot appear in a cuid, so composite keys split cleanly. */
const KEY_SEP = ' '

export type WorkLearningStats = {
  organizationId: string
  rulesLearned: number
  rulesPromoted: number
  rulesRetired: number
  cadenceProposals: number
}

const RULE_SCOPE_SELECT = {
  id: true,
  signal: true,
  statement: true,
  goalId: true,
  seedKey: true,
  resourceId: true,
  learnedAt: true,
} as const

export async function runGoalWorkLearning(
  organizationId: string,
  db = systemPrisma,
): Promise<WorkLearningStats> {
  const stats: WorkLearningStats = {
    organizationId,
    rulesLearned: 0,
    rulesPromoted: 0,
    rulesRetired: 0,
    cadenceProposals: 0,
  }

  try {
    const now = new Date()
    const since = new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * DAY_MS)

    const rows = await db.goalWork.findMany({
      where: { organizationId, createdAt: { gte: since } },
      select: {
        goalId: true,
        resourceId: true,
        disposition: true,
        skipReason: true,
        signals: true,
        probeForRuleId: true,
      },
    })
    if (rows.length === 0) return stats

    const contributions = await db.goalContribution.findMany({
      where: { organizationId },
      select: { goalId: true, resourceId: true, seedKey: true },
    })
    const seedFor = new Map(
      contributions.map((row) => [`${row.goalId}${KEY_SEP}${row.resourceId}`, row.seedKey] as const),
    )

    const toExisting = (rule: {
      id: string
      signal: string
      statement: string
      goalId: string | null
      seedKey: string | null
      resourceId: string | null
      learnedAt: Date
    }): ExistingRule => ({
      id: rule.id,
      signal: rule.signal,
      statement: rule.statement,
      goalId: rule.goalId,
      seedKey: rule.seedKey,
      agentSeedKey: seedFor.get(`${rule.goalId}${KEY_SEP}${rule.resourceId}`) ?? null,
      learnedAt: rule.learnedAt,
    })

    // ── Retire FIRST, so a rule the probes just killed does not block
    //    relearning the same signal from fresh evidence in this same tick. ──
    const active = await db.goalWorkRule.findMany({
      where: { organizationId, status: 'active' },
      select: RULE_SCOPE_SELECT,
    })

    const tallies = new Map<string, ProbeTally>()
    for (const row of rows) {
      if (!row.probeForRuleId) continue
      const tally = tallies.get(row.probeForRuleId) ?? {
        ruleId: row.probeForRuleId,
        probes: 0,
        used: 0,
      }
      tally.probes += 1
      if (row.disposition === 'used' || row.disposition === 'edited') tally.used += 1
      tallies.set(row.probeForRuleId, tally)
    }

    for (const decision of rulesToRetire(active.map(toExisting), [...tallies.values()], now)) {
      await db.goalWorkRule.updateMany({
        where: { id: decision.ruleId, organizationId },
        data: { status: 'retired', retiredAt: now, retiredReason: decision.reason },
      })
      stats.rulesRetired += 1
    }

    // ── Earn ──────────────────────────────────────────────────────────────
    const byPair = new Map<string, WorkObservation[]>()
    for (const row of rows) {
      // Probes are excluded from earning evidence: they exist precisely
      // BECAUSE a rule said not to work them, so counting them would let a
      // rule re-earn itself from its own exceptions.
      if (row.probeForRuleId) continue
      const key = `${row.goalId}${KEY_SEP}${row.resourceId}`
      const bucket = byPair.get(key) ?? []
      bucket.push({
        disposition: row.disposition as Disposition,
        skipReason: row.skipReason,
        signals: (row.signals as Record<string, unknown> | null) ?? null,
      })
      byPair.set(key, bucket)
    }

    const stillActive = new Set(
      (
        await db.goalWorkRule.findMany({
          where: { organizationId, status: 'active' },
          select: { goalId: true, resourceId: true, signal: true },
        })
      ).map((rule) => `${rule.goalId}${KEY_SEP}${rule.resourceId}${KEY_SEP}${rule.signal}`),
    )

    for (const [key, observations] of byPair) {
      const [goalId, resourceId] = key.split(KEY_SEP)
      const candidates = findRuleCandidates(observations)

      for (const candidate of candidates) {
        if (stillActive.has(`${goalId}${KEY_SEP}${resourceId}${KEY_SEP}${candidate.signal}`)) continue
        await db.goalWorkRule.create({
          data: {
            organizationId,
            goalId,
            resourceId,
            signal: candidate.signal,
            statement: candidate.statement,
            skippedCount: candidate.skippedCount,
            totalCount: candidate.totalCount,
            topSkipReason: candidate.topSkipReason,
            exploreRate: EXPLORE_RATE,
          },
        })
        stillActive.add(`${goalId}${KEY_SEP}${resourceId}${KEY_SEP}${candidate.signal}`)
        stats.rulesLearned += 1
      }

      // ── Tier 3: only when no rule was derivable ──────────────────────────
      const produced = observations.length
      const skipped = observations.filter((row) => row.disposition === 'skipped').length
      if (!shouldProposeCadenceChange({ produced, skipped, candidates: candidates.length })) continue

      const goal = await db.goal.findFirst({
        where: { id: goalId, organizationId },
        select: { name: true, ownerUserId: true, createdByUserId: true },
      })
      const userId = goal?.ownerUserId ?? goal?.createdByUserId
      // No addressable user means nobody to ask; skip rather than orphan a row.
      if (!goal || !userId) continue

      // One open proposal per agent — re-proposing every week is nagging.
      const open = await db.userSuggestion.count({
        where: {
          organizationId,
          userId,
          status: 'open',
          kind: 'enhancement',
          targetType: 'agent',
          targetId: resourceId,
        },
      })
      if (open > 0) continue

      await db.userSuggestion.create({
        data: {
          organizationId,
          userId,
          kind: 'enhancement',
          title: 'Produce less, more often used',
          description:
            `This agent produced ${produced} items for "${goal.name}" and ${skipped} were skipped, ` +
            'with no common reason we could find. Running it less often would likely raise the share that gets used.',
          targetType: 'agent',
          targetId: resourceId,
          evidence: [`${skipped} of ${produced} skipped`, 'no targeting pattern found'],
          metadata: { goalId, reason: 'cadence' },
        },
      })
      stats.cadenceProposals += 1
    }

    // ── Promote ───────────────────────────────────────────────────────────
    const afterEarn = await db.goalWorkRule.findMany({
      where: { organizationId, status: 'active' },
      select: RULE_SCOPE_SELECT,
    })

    for (const decision of rulesToPromote(afterEarn.map(toExisting))) {
      await db.goalWorkRule.create({
        data: {
          organizationId,
          goalId: null,
          resourceId: null,
          seedKey: decision.seedKey,
          signal: decision.signal,
          statement: decision.statement,
          // The evidence for a promoted rule is the goals it was seen on, not
          // a fresh count of subjects.
          skippedCount: decision.fromGoalIds.length,
          totalCount: decision.fromGoalIds.length,
          exploreRate: EXPLORE_RATE,
        },
      })
      stats.rulesPromoted += 1
    }
  } catch (error) {
    apiLogger.warn('goals.runGoalWorkLearning failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return stats
}
