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

export type OrgMember = { id: string; email: string | null; name: string | null }

/**
 * Resolve an agent's free-text assignee hint to an org member. Exported and
 * pure so the matching rules are testable without a database.
 *
 * Returns null rather than throwing or guessing. An agent that read a name off
 * a CRM record must never fail its run because that person is not a Sublime
 * user, and an ambiguous match is worse than no match: the unassigned pool is
 * visible and claimable, whereas a mis-assignment is silent.
 */
export function resolveAssignee(
  hint: string | null | undefined,
  members: OrgMember[],
): string | null {
  const needle = (hint ?? '').trim().toLowerCase()
  if (!needle) return null

  const byEmail = members.filter((member) => (member.email ?? '').toLowerCase() === needle)
  if (byEmail.length === 1) return byEmail[0].id

  const byName = members.filter((member) => (member.name ?? '').toLowerCase() === needle)
  return byName.length === 1 ? byName[0].id : null
}

export function prismaGoalsPort(
  organizationId: string,
  resource?: GoalResource,
): GoalsDataPort {
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

    async writeWork(goalId: string, input) {
      // Resolve the hint against real members; unresolvable means Unassigned,
      // never an error — see resolveAssignee.
      const members = await prisma.user.findMany({
        where: { organizationId },
        select: { id: true, email: true, name: true },
      })
      const assigneeUserId = resolveAssignee(input.assigneeHint, members)

      const created = await prisma.goalWork.create({
        data: {
          organizationId,
          goalId,
          // The plane loader always constructs this port with its resource;
          // the fallback exists so a mis-wired caller records provenance it
          // can still be filtered on rather than throwing mid-run.
          resourceType: resource?.type ?? 'agent',
          resourceId: resource?.id ?? 'unknown',
          subject: input.subject,
          subjectRef: input.subjectRef,
          produced: input.produced,
          body: input.body,
          bodyFormat: input.bodyFormat,
          assigneeUserId,
          // undefined rather than null so Prisma omits the JSON column instead
          // of writing SQL NULL over it — both read back as null.
          signals: input.signals === null ? undefined : (input.signals as object),
          probeForRuleId: input.probeRuleId,
        },
        select: { id: true },
      })
      return { id: created.id, assigned: assigneeUserId !== null }
    },

    async listWork(goalId: string, limit: number, disposition?: string) {
      return prisma.goalWork.findMany({
        where: { organizationId, goalId, ...(disposition ? { disposition } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          subject: true,
          subjectRef: true,
          produced: true,
          disposition: true,
          outcome: true,
          assigneeUserId: true,
          createdAt: true,
        },
      })
    },
  }
}
