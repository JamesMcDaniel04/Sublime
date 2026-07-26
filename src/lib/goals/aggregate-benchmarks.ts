/**
 * Global k-anonymous goal-outcome benchmarks.
 *
 * Privacy model: the ONLY things that cross an org boundary are per-kind
 * COUNTS — distinct orgs, settled outcomes, achieved outcomes — plus
 * platform-catalogue seed keys ranked by adoption. No goal names, values,
 * org ids, or user ids are stored; rows surface only at the
 * MIN_BENCHMARK_ORGS floor (enforced at read time in surfaceGoalBenchmark).
 *
 * Runs as a weekly global cron sweep (systemPrisma: cross-tenant by design,
 * CRON_SECRET-gated at the route). Pure helpers carry the math so the
 * k-anonymity contract is testable without a database.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import {
  adoptionScore,
  loadTemplateAdoptionScores,
  type AdoptionStat,
} from '@/lib/templates/adoption'
import { goalTemplatesFor } from '@/lib/templates/goal-fit'
import { SEED_CATALOGUE, type SeedTemplate } from '@/lib/templates/catalogue'

export const MIN_BENCHMARK_ORGS = 5

export type GoalOutcome = {
  kind: string
  organizationId: string
  outcome: 'achieved' | 'missed'
  /** Pre-aggregated row weight (exact DB group counts); defaults to 1. */
  count?: number
}

export type BenchmarkTopSeed = {
  seedKey: string
  name: string
  deploys: number
}

export type GoalBenchmarkRow = {
  kind: string
  orgCount: number
  settledCount: number
  achievedCount: number
  topSeedKeys: BenchmarkTopSeed[]
}

export function computeGoalBenchmarks(
  outcomes: GoalOutcome[],
  seeds: SeedTemplate[],
  adoption: Record<string, AdoptionStat>,
): GoalBenchmarkRow[] {
  const grouped = new Map<string, GoalOutcome[]>()
  for (const outcome of outcomes) {
    const group = grouped.get(outcome.kind) ?? []
    group.push(outcome)
    grouped.set(outcome.kind, group)
  }
  return [...grouped.entries()].map(([kind, group]) => {
    const candidates = goalTemplatesFor(kind, seeds)
      .map((seed, index) => {
        const stat = adoption[`seed:${seed.seedKey}`] ?? { deploys: 0, surviving: 0 }
        return { seed, stat, index }
      })
      .filter((entry) => entry.stat.deploys > 0)
      .sort(
        (left, right) =>
          adoptionScore(right.stat) - adoptionScore(left.stat) ||
          left.index - right.index,
      )
      .slice(0, 3)
      .map(({ seed, stat }) => ({
        seedKey: seed.seedKey,
        name: seed.name,
        deploys: stat.deploys,
      }))
    return {
      kind,
      orgCount: new Set(group.map((outcome) => outcome.organizationId)).size,
      settledCount: group.reduce((sum, outcome) => sum + (outcome.count ?? 1), 0),
      achievedCount: group.reduce(
        (sum, outcome) => sum + (outcome.outcome === 'achieved' ? (outcome.count ?? 1) : 0),
        0,
      ),
      topSeedKeys: candidates,
    }
  })
}

export function surfaceGoalBenchmark(
  row:
    | {
        orgCount: number
        settledCount: number
        achievedCount: number
        topSeedKeys: unknown
      }
    | null,
  minOrgs = MIN_BENCHMARK_ORGS,
): { orgCount: number; achievedRate: number; topSeeds: BenchmarkTopSeed[] } | null {
  if (!row || row.orgCount < minOrgs || row.settledCount <= 0) return null
  const topSeeds = Array.isArray(row.topSeedKeys)
    ? row.topSeedKeys.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return []
        const seed = value as Record<string, unknown>
        return typeof seed.seedKey === 'string' &&
          typeof seed.name === 'string' &&
          typeof seed.deploys === 'number'
          ? [{
              seedKey: seed.seedKey,
              name: seed.name,
              deploys: seed.deploys,
            }]
          : []
      })
    : []
  return {
    orgCount: row.orgCount,
    achievedRate: Math.round((row.achievedCount / row.settledCount) * 100),
    topSeeds: topSeeds.slice(0, 3),
  }
}

export function shouldRunGoalBenchmarkSweep(now: Date): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() === 4 && now.getUTCMinutes() < 15
}

export async function aggregateGoalBenchmarks(
  db = systemPrisma,
): Promise<{ benchmarks: number } | { skipped: string }> {
  try {
    // Exact grouped aggregates — no row caps. A truncated sample would
    // silently deflate orgCount toward the k-floor and skew achievedRate on
    // a number the UI presents as cross-workspace truth.
    const [oneShotGroups, periodGroups, adoption] = await Promise.all([
      db.goal.groupBy({
        by: ['kind', 'organizationId', 'status'],
        where: { status: { in: ['achieved', 'missed'] } },
        _count: { _all: true },
      }),
      // Raw join: Prisma groupBy cannot reach the parent goal's kind.
      // systemPrisma raw read: global k-anon aggregation, CRON_SECRET-gated.
      db.$queryRaw<
        Array<{ kind: string; organizationId: string; outcome: string; count: number }>
      >`
        SELECT g.kind, gp."organizationId", gp.outcome, COUNT(*)::int AS count
        FROM goal_periods gp
        JOIN goals g ON g.id = gp."goalId"
        GROUP BY g.kind, gp."organizationId", gp.outcome
      `,
      loadTemplateAdoptionScores(db),
    ])
    const outcomes: GoalOutcome[] = [
      ...oneShotGroups.map((group) => ({
        kind: group.kind,
        organizationId: group.organizationId,
        outcome: group.status as 'achieved' | 'missed',
        count: group._count._all,
      })),
      ...periodGroups.map((group) => ({
        kind: group.kind,
        organizationId: group.organizationId,
        outcome: group.outcome as 'achieved' | 'missed',
        count: group.count,
      })),
    ]
    const rows = computeGoalBenchmarks(outcomes, SEED_CATALOGUE, adoption)
    for (const row of rows) {
      await db.goalBenchmark.upsert({
        where: { kind: row.kind },
        create: row,
        update: {
          orgCount: row.orgCount,
          settledCount: row.settledCount,
          achievedCount: row.achievedCount,
          topSeedKeys: row.topSeedKeys,
        },
      })
    }
    return { benchmarks: rows.length }
  } catch (error) {
    apiLogger.warn('aggregateGoalBenchmarks failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { scope: 'goals.aggregate-benchmarks' })
    return { skipped: 'error' }
  }
}
