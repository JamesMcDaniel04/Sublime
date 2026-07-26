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
      settledCount: group.length,
      achievedCount: group.filter((outcome) => outcome.outcome === 'achieved').length,
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
    const [oneShotGoals, periods, adoption] = await Promise.all([
      db.goal.findMany({
        where: { status: { in: ['achieved', 'missed'] } },
        select: { kind: true, organizationId: true, status: true },
        take: 10_000,
      }),
      db.goalPeriod.findMany({
        select: {
          organizationId: true,
          outcome: true,
          goal: { select: { kind: true } },
        },
        take: 10_000,
      }),
      loadTemplateAdoptionScores(db),
    ])
    const outcomes: GoalOutcome[] = [
      ...oneShotGoals.map((goal) => ({
        kind: goal.kind,
        organizationId: goal.organizationId,
        outcome: goal.status as 'achieved' | 'missed',
      })),
      ...periods.map((period) => ({
        kind: period.goal.kind,
        organizationId: period.organizationId,
        outcome: period.outcome as 'achieved' | 'missed',
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
