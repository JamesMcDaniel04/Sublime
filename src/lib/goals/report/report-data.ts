import { prisma } from '@/lib/prisma'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { evaluateGoal } from '@/lib/goals/evaluate'
import { contributionRunStats, goalImpact, orgImpact, type ImpactTiers } from '@/lib/goals/impact'
import { agentReadScope, flowReadScope } from '@/lib/server/visibility'

const HOUR_MS = 60 * 60 * 1000

export type ReportContribution = {
  name: string
  origin: string
  runs: number
  avgRunSeconds: number | null
  estimatedMinutesSavedPerRun: number
}

export type ReportGoal = {
  id: string
  name: string
  direction: string
  unit: string
  status: string
  riskLevel: string
  currentValue: number | null
  startValue: number
  targetValue: number
  startAt: Date
  targetDate: Date
  expectedProgress: number
  paceDeltaPct: number | null
  points: Array<{ value: number; capturedAt: Date }>
  periods: Array<{ periodEnd: Date; outcome: string }>
  contributions: ReportContribution[]
  impact: ImpactTiers
}

export type RoiReportData = {
  organizationName: string
  months: 3 | 6 | 12
  windowStart: Date
  generatedAt: Date
  impact: ImpactTiers & { goalsTracked: number; contributionsLinked: number }
  goals: ReportGoal[]
}

export type ReportGoalCandidate = {
  ownerUserId: string | null
  status: string
  updatedAt: Date
}

export function selectReportGoalRows<T extends ReportGoalCandidate>(
  rows: T[],
  viewerUserId: string,
  cutoff: Date,
  cap = 12,
): T[] {
  return rows
    .filter(
      (row) =>
        (row.ownerUserId === null || row.ownerUserId === viewerUserId) &&
        (row.status === 'active' ||
          row.status === 'paused' ||
          ((row.status === 'achieved' || row.status === 'missed') &&
            row.updatedAt.getTime() >= cutoff.getTime())),
    )
    .sort((left, right) => {
      const leftActive = left.status === 'active' || left.status === 'paused'
      const rightActive = right.status === 'active' || right.status === 'paused'
      if (leftActive !== rightActive) return leftActive ? -1 : 1
      return right.updatedAt.getTime() - left.updatedAt.getTime()
    })
    .slice(0, cap)
}

async function contributionForReport(
  organizationId: string,
  viewerUserId: string,
  contribution: {
    resourceType: string
    resourceId: string
    origin: string
    estimatedMinutesSavedPerRun: number
    createdAt: Date
  },
): Promise<ReportContribution> {
  // Names resolve with viewer visibility; run math comes from the single
  // shared loader so the PDF can never disagree with the app.
  if (contribution.resourceType === 'flow') {
    const [flow, stats] = await Promise.all([
      prisma.flow.findFirst({
        where: {
          id: contribution.resourceId,
          organizationId,
          ...flowReadScope(viewerUserId),
        },
        select: { name: true },
      }),
      contributionRunStats(organizationId, contribution),
    ])
    return {
      name: flow?.name ?? 'Private automation',
      origin: contribution.origin,
      runs: stats.runs,
      avgRunSeconds: stats.measuredRunSeconds.avg,
      estimatedMinutesSavedPerRun: contribution.estimatedMinutesSavedPerRun,
    }
  }

  const [agent, stats] = await Promise.all([
    prisma.agentTask.findFirst({
      where: {
        id: contribution.resourceId,
        organizationId,
        status: { not: 'DELETED' },
        ...agentReadScope(viewerUserId),
      },
      select: { description: true, metadata: true },
    }),
    contributionRunStats(organizationId, contribution),
  ])
  const metadata = agent ? readAgentMetadata(agent.metadata) : null
  return {
    name: metadata?.title || agent?.description || 'Private automation',
    origin: contribution.origin,
    runs: stats.runs,
    avgRunSeconds: stats.measuredRunSeconds.avg,
    estimatedMinutesSavedPerRun: contribution.estimatedMinutesSavedPerRun,
  }
}

export async function assembleRoiReportData(params: {
  organizationId: string
  viewerUserId: string
  months: 3 | 6 | 12
  now?: Date
}): Promise<RoiReportData> {
  const generatedAt = params.now ?? new Date()
  // Anchor to day 1 before subtracting months: setUTCMonth on a long
  // month-end overflows (Jul 31 − 3 months would land on May 1, not Apr 30 —
  // and worse, Mar 31 − 1 month lands on Mar 3).
  const windowStart = new Date(
    Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth() - params.months, 1),
  )

  const [organization, candidates, impact] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: params.organizationId },
      select: { name: true },
    }),
    prisma.goal.findMany({
      where: {
        organizationId: params.organizationId,
        status: { not: 'archived' },
        // Visibility in the QUERY, not just post-filtering: other users'
        // personal goals must not consume the 200-row candidate budget.
        OR: [{ ownerUserId: null }, { ownerUserId: params.viewerUserId }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        metrics: {
          where: { role: 'primary' },
          take: 1,
          include: {
            datapoints: {
              where: { capturedAt: { gte: windowStart } },
              orderBy: { capturedAt: 'asc' },
              take: 400,
              select: { value: true, capturedAt: true },
            },
          },
        },
        periods: {
          where: { periodEnd: { gte: windowStart } },
          orderBy: { periodEnd: 'desc' },
          take: 12,
          select: { periodEnd: true, outcome: true },
        },
        contributions: {
          orderBy: { createdAt: 'asc' },
          select: {
            resourceType: true,
            resourceId: true,
            origin: true,
            estimatedMinutesSavedPerRun: true,
            createdAt: true,
          },
        },
      },
    }),
    orgImpact(params.organizationId, params.viewerUserId),
  ])

  const selected = selectReportGoalRows(
    candidates,
    params.viewerUserId,
    windowStart,
  )
  const goals = await Promise.all(
    selected.map(async (goal): Promise<ReportGoal> => {
      const metric = goal.metrics[0] ?? null
      const points = metric?.datapoints ?? []
      const evaluation = evaluateGoal(
        { ...goal, direction: goal.direction as 'increase' | 'decrease' },
        points,
        generatedAt,
        2 * (metric?.refreshIntervalHours ?? 24) * HOUR_MS,
      )
      const [contributions, perGoalImpact] = await Promise.all([
        Promise.all(
          goal.contributions.map((contribution) =>
            contributionForReport(
              params.organizationId,
              params.viewerUserId,
              contribution,
            ),
          ),
        ),
        goalImpact(params.organizationId, goal.id),
      ])
      return {
        id: goal.id,
        name: goal.name,
        direction: goal.direction,
        unit: goal.unit,
        status: goal.status,
        riskLevel: goal.riskLevel,
        currentValue: evaluation.currentValue,
        startValue: goal.startValue,
        targetValue: goal.targetValue,
        startAt: goal.startAt,
        targetDate: goal.targetDate,
        expectedProgress: evaluation.expectedProgress,
        paceDeltaPct: perGoalImpact.correlated.paceDeltaPct,
        points,
        periods: goal.periods,
        contributions,
        impact: perGoalImpact,
      }
    }),
  )

  return {
    organizationName: organization?.name ?? 'Sublime workspace',
    months: params.months,
    windowStart,
    generatedAt,
    impact,
    goals,
  }
}
