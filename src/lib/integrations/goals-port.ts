/**
 * Prisma-backed GoalsDataPort, plus the scoping query the plane loader uses to
 * decide which goals a resource may touch. Kept out of ./goals so the tool
 * client stays database-free and unit-testable.
 */

import { prisma } from '@/lib/prisma'
import { bucketKeyFor } from '@/lib/goals/refresh'
import { AGENT_DATAPOINT_ORIGIN } from '@/lib/goals/agent-tool-policy'
import type { AgentGoalView, GoalsDataPort } from '@/lib/integrations/goals'

export type GoalResource = { type: 'agent' | 'flow'; id: string }

/** The narrow slice of Prisma this module needs, so tests can pass a fake. */
type ContributionDb = {
  goalContribution: {
    findMany(args: {
      where: { organizationId: string; resourceType: string; resourceId: string }
      select?: unknown
    }): Promise<{ goalId: string }[]>
  }
}

/**
 * Every goal this resource is linked to. This is the ENTIRE authorization
 * input: the returned set becomes the client's reachable universe, so a bug
 * here is a scoping bug, not a display bug.
 */
export async function resolveLinkedGoalIds(
  organizationId: string,
  resource: GoalResource,
  db: ContributionDb = prisma as unknown as ContributionDb,
): Promise<string[]> {
  const rows = await db.goalContribution.findMany({
    where: {
      organizationId,
      resourceType: resource.type,
      resourceId: resource.id,
    },
    select: { goalId: true },
  })
  return [...new Set(rows.map((row) => row.goalId))]
}

export function prismaGoalsPort(organizationId: string): GoalsDataPort {
  const primaryMetric = async (goalId: string) =>
    prisma.goalMetric.findFirst({
      where: { organizationId, goalId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, source: true, refreshIntervalHours: true },
    })

  return {
    async getGoal(goalId: string): Promise<AgentGoalView | null> {
      const goal = await prisma.goal.findFirst({
        where: { id: goalId, organizationId },
        select: {
          id: true,
          name: true,
          kind: true,
          unit: true,
          direction: true,
          startValue: true,
          targetValue: true,
          startAt: true,
          targetDate: true,
          recurrence: true,
          createdAt: true,
        },
      })
      if (!goal) return null
      const metric = await primaryMetric(goalId)
      return {
        ...goal,
        direction: goal.direction as 'increase' | 'decrease',
        primarySource: metric?.source ?? null,
        refreshIntervalHours: metric?.refreshIntervalHours ?? 24,
      }
    },

    async listDatapoints(goalId: string, limit: number) {
      const metric = await primaryMetric(goalId)
      if (!metric) return []
      return prisma.metricDatapoint.findMany({
        where: { organizationId, goalMetricId: metric.id },
        orderBy: { capturedAt: 'desc' },
        take: limit,
        select: { value: true, capturedAt: true },
      })
    },

    async writeDatapoint(goalId: string, value: number, capturedAt: Date) {
      const metric = await primaryMetric(goalId)
      if (!metric) throw new Error('This goal has no metric configured yet.')
      const bucketKey = bucketKeyFor(capturedAt)
      // Same upsert discipline as the sync path: one row per metric per UTC
      // day, never a double write. origin='assisted' inherits the existing
      // "AI-read" labeling with no UI change.
      await prisma.metricDatapoint.upsert({
        where: {
          goalMetricId_bucketKey: { goalMetricId: metric.id, bucketKey },
          organizationId,
        },
        create: {
          organizationId,
          goalMetricId: metric.id,
          value,
          capturedAt,
          bucketKey,
          origin: AGENT_DATAPOINT_ORIGIN,
        },
        update: { value, capturedAt, origin: AGENT_DATAPOINT_ORIGIN },
      })
    },
  }
}
