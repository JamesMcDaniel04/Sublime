import { prisma } from '@/lib/prisma'
import type { EvalPoint } from './evaluate'

export interface ImpactTiers {
  measured: { runsCompleted: number; tokens: number; aiRunSecondsTotal: number }
  estimated: {
    hoursSaved: number
    laborValueUsd: number
    aiCostUsd: number
    roiMultiple: number | null
    hourlyRateUsd: number
    aiCostPerMTokensUsd: number
  }
  correlated: { paceDeltaPct: number | null }
}

export function computeImpact(inputs: {
  contributions: Array<{
    estimatedMinutesSavedPerRun: number
    runs: number
    tokens: number
    measuredRunSeconds: { total: number; avg: number | null }
  }>
  hourlyRateUsd: number
  aiCostPerMTokensUsd: number
  paceBefore: number | null
  paceAfter: number | null
}): ImpactTiers {
  const runsCompleted = inputs.contributions.reduce((sum, contribution) => sum + contribution.runs, 0)
  const tokens = inputs.contributions.reduce((sum, contribution) => sum + contribution.tokens, 0)
  const aiRunSecondsTotal = inputs.contributions.reduce(
    (sum, contribution) => sum + contribution.measuredRunSeconds.total,
    0,
  )
  const minutesSaved = inputs.contributions.reduce(
    (sum, contribution) =>
      sum + contribution.runs * contribution.estimatedMinutesSavedPerRun,
    0,
  )
  const hoursSaved = minutesSaved / 60
  const laborValueUsd = hoursSaved * inputs.hourlyRateUsd
  const aiCostUsd = (tokens / 1_000_000) * inputs.aiCostPerMTokensUsd
  const roiMultiple = aiCostUsd > 0 ? laborValueUsd / aiCostUsd : null
  const paceDeltaPct =
    inputs.paceBefore !== null && inputs.paceAfter !== null && inputs.paceBefore !== 0
      ? ((inputs.paceAfter - inputs.paceBefore) / Math.abs(inputs.paceBefore)) * 100
      : null
  return {
    measured: { runsCompleted, tokens, aiRunSecondsTotal },
    estimated: {
      hoursSaved,
      laborValueUsd,
      aiCostUsd,
      roiMultiple,
      hourlyRateUsd: inputs.hourlyRateUsd,
      aiCostPerMTokensUsd: inputs.aiCostPerMTokensUsd,
    },
    correlated: { paceDeltaPct },
  }
}

/** Least-squares slope in value/day on each side of splitAt. */
export function paceDelta(
  points: EvalPoint[],
  splitAt: Date,
): { before: number | null; after: number | null } {
  const DAY = 24 * 60 * 60 * 1000
  const slope = (side: EvalPoint[]): number | null => {
    if (side.length < 2) return null
    const xs = side.map((point) => point.capturedAt.getTime() / DAY)
    const ys = side.map((point) => point.value)
    const n = xs.length
    const meanX = xs.reduce((a, b) => a + b, 0) / n
    const meanY = ys.reduce((a, b) => a + b, 0) / n
    let sxy = 0
    let sxx = 0
    for (let index = 0; index < n; index += 1) {
      sxy += (xs[index] - meanX) * (ys[index] - meanY)
      sxx += (xs[index] - meanX) ** 2
    }
    return sxx === 0 ? null : sxy / sxx
  }
  return {
    before: slope(points.filter((point) => point.capturedAt.getTime() < splitAt.getTime())),
    after: slope(points.filter((point) => point.capturedAt.getTime() >= splitAt.getTime())),
  }
}

function impactSettings(settings: unknown): {
  hourlyRateUsd: number
  aiCostPerMTokensUsd: number
} {
  const value = (settings ?? {}) as Record<string, unknown>
  return {
    hourlyRateUsd:
      typeof value.laborHourlyRate === 'number' && value.laborHourlyRate > 0
        ? value.laborHourlyRate
        : 50,
    aiCostPerMTokensUsd:
      typeof value.aiCostPerMTokensUsd === 'number' && value.aiCostPerMTokensUsd > 0
        ? value.aiCostPerMTokensUsd
        : 10,
  }
}

type ContributionRow = {
  resourceType: string
  resourceId: string
  estimatedMinutesSavedPerRun: number
  createdAt: Date
}

export type ContributionRunStats = {
  runs: number
  tokens: number
  measuredRunSeconds: { total: number; avg: number | null }
}

/** Pure: flow-run rows → stats. A succeeded run with no finishedAt is
 *  unmeasurable and is EXCLUDED from both the count and the average — a zero
 *  in the numerator with a spot in the denominator would understate avg. */
export function flowRunStatsOf(rows: Array<{ startedAt: Date; finishedAt: Date | null }>): ContributionRunStats {
  const measurable = rows.filter((run) => run.finishedAt !== null)
  const total = measurable.reduce(
    (sum, run) => sum + Math.max(0, (run.finishedAt as Date).getTime() - run.startedAt.getTime()) / 1000,
    0,
  )
  return {
    runs: measurable.length,
    tokens: 0,
    measuredRunSeconds: { total, avg: measurable.length > 0 ? total / measurable.length : null },
  }
}

/** Pure: agent-execution rows → stats. executionTime is persisted in ms. */
export function agentRunStatsOf(
  rows: Array<{ inputTokens: number; outputTokens: number; executionTime: number | null }>,
): ContributionRunStats {
  const total = rows.reduce((sum, run) => sum + Math.max(0, run.executionTime ?? 0) / 1000, 0)
  return {
    runs: rows.length,
    tokens: rows.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0),
    measuredRunSeconds: { total, avg: rows.length > 0 ? total / rows.length : null },
  }
}

/** The ONE loader every surface uses (impact tiers, contributions API, PDF
 *  report) — a duration-rule change lands everywhere at once. */
export async function contributionRunStats(
  organizationId: string,
  contribution: Pick<ContributionRow, 'resourceType' | 'resourceId' | 'createdAt'>,
): Promise<ContributionRunStats> {
  if (contribution.resourceType === 'flow') {
    const rows = await prisma.flowRun.findMany({
      where: {
        organizationId,
        flowId: contribution.resourceId,
        status: 'succeeded',
        startedAt: { gt: contribution.createdAt },
      },
      select: { startedAt: true, finishedAt: true },
    })
    return flowRunStatsOf(rows)
  }
  if (contribution.resourceType === 'agent') {
    const rows = await prisma.agentExecution.findMany({
      where: {
        organizationId,
        agentTaskId: contribution.resourceId,
        completedAt: { not: null },
        error: null,
        startedAt: { gt: contribution.createdAt },
      },
      select: { inputTokens: true, outputTokens: true, executionTime: true },
    })
    return agentRunStatsOf(rows)
  }
  return { runs: 0, tokens: 0, measuredRunSeconds: { total: 0, avg: null } }
}

async function contributionStats(
  organizationId: string,
  contributions: ContributionRow[],
): Promise<
  Array<{
    estimatedMinutesSavedPerRun: number
    runs: number
    tokens: number
    measuredRunSeconds: { total: number; avg: number | null }
  }>
> {
  return Promise.all(
    contributions.map(async (contribution) => ({
      estimatedMinutesSavedPerRun: contribution.estimatedMinutesSavedPerRun,
      ...(await contributionRunStats(organizationId, contribution)),
    })),
  )
}

async function settingsFor(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  })
  return impactSettings(organization?.settings)
}

export async function goalImpact(
  organizationId: string,
  goalId: string,
): Promise<ImpactTiers> {
  const [contributions, metric, settings] = await Promise.all([
    prisma.goalContribution.findMany({
      where: { organizationId, goalId },
      select: {
        resourceType: true,
        resourceId: true,
        estimatedMinutesSavedPerRun: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.goalMetric.findFirst({
      where: { organizationId, goalId },
      select: { id: true },
    }),
    settingsFor(organizationId),
  ])

  const stats = await contributionStats(organizationId, contributions)
  let before: number | null = null
  let after: number | null = null
  if (metric && contributions[0]) {
    const points = await prisma.metricDatapoint.findMany({
      where: { organizationId, goalMetricId: metric.id },
      orderBy: { capturedAt: 'asc' },
      take: 400,
      select: { value: true, capturedAt: true },
    })
    ;({ before, after } = paceDelta(points, contributions[0].createdAt))
  }
  return computeImpact({
    contributions: stats,
    ...settings,
    paceBefore: before,
    paceAfter: after,
  })
}

export async function orgImpact(
  organizationId: string,
  viewerUserId: string,
): Promise<ImpactTiers & { goalsTracked: number; contributionsLinked: number }> {
  // Same visibility rule as every goals read: org goals plus the viewer's own
  // personal goals — other users' personal goals stay out of the aggregates.
  const visibleGoal = { OR: [{ ownerUserId: null }, { ownerUserId: viewerUserId }] }
  const [contributions, goalsTracked, settings] = await Promise.all([
    prisma.goalContribution.findMany({
      where: { organizationId, goal: visibleGoal },
      select: {
        resourceType: true,
        resourceId: true,
        estimatedMinutesSavedPerRun: true,
        createdAt: true,
      },
    }),
    prisma.goal.count({ where: { organizationId, status: { not: 'archived' }, ...visibleGoal } }),
    settingsFor(organizationId),
  ])
  const stats = await contributionStats(organizationId, contributions)
  return {
    ...computeImpact({
      contributions: stats,
      ...settings,
      paceBefore: null,
      paceAfter: null,
    }),
    goalsTracked,
    contributionsLinked: contributions.length,
  }
}
