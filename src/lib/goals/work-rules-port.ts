/**
 * Loads everything a run needs to render its feedback block: the recent
 * funnel, why people skipped, and the rules in force.
 *
 * Both rule levels apply. A level-2 (seed-wide) rule about a signal a level-1
 * (this agent, this goal) rule already covers is dropped — the narrower
 * observation was made where the work actually happens.
 */
import { prisma } from '@/lib/prisma'
import { computeWorkStats } from '@/lib/goals/work-stats'
import type { Disposition, Outcome } from '@/lib/goals/work-transitions'
import type { FeedbackInput, FeedbackRule } from '@/lib/goals/work-feedback'

export const STATS_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

type RuleRow = {
  id: string
  signal: string
  statement: string
  skippedCount: number
  totalCount: number
  topSkipReason: string | null
  exploreRate: number
}

const toFeedbackRule = (rule: RuleRow): FeedbackRule => ({
  id: rule.id,
  statement: rule.statement,
  skippedCount: rule.skippedCount,
  totalCount: rule.totalCount,
  topSkipReason: rule.topSkipReason,
  exploreRate: rule.exploreRate,
})

const RULE_SELECT = {
  id: true,
  signal: true,
  statement: true,
  skippedCount: true,
  totalCount: true,
  topSkipReason: true,
  exploreRate: true,
} as const

export async function loadWorkFeedback(
  organizationId: string,
  goalId: string,
  resourceId: string,
): Promise<FeedbackInput | null> {
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organizationId },
    select: { name: true },
  })
  if (!goal) return null

  const since = new Date(Date.now() - STATS_WINDOW_DAYS * DAY_MS)
  const rows = await prisma.goalWork.findMany({
    where: { organizationId, goalId, resourceId, createdAt: { gte: since } },
    select: { disposition: true, outcome: true, skipReason: true },
  })

  const stats = computeWorkStats(
    rows.map((row) => ({
      resourceId,
      resourceName: '',
      disposition: row.disposition as Disposition,
      outcome: row.outcome as Outcome,
    })),
  ).overall

  const reasonCounts = new Map<string, number>()
  for (const row of rows) {
    if (row.disposition !== 'skipped' || !row.skipReason) continue
    reasonCounts.set(row.skipReason, (reasonCounts.get(row.skipReason) ?? 0) + 1)
  }
  const skipReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))

  const contribution = await prisma.goalContribution.findFirst({
    where: { organizationId, goalId, resourceId },
    select: { seedKey: true },
  })

  const [level1, level2] = await Promise.all([
    prisma.goalWorkRule.findMany({
      where: { organizationId, goalId, resourceId, status: 'active' },
      orderBy: { learnedAt: 'asc' },
      select: RULE_SELECT,
    }),
    contribution?.seedKey
      ? prisma.goalWorkRule.findMany({
          where: {
            organizationId,
            seedKey: contribution.seedKey,
            goalId: null,
            status: 'active',
          },
          orderBy: { learnedAt: 'asc' },
          select: RULE_SELECT,
        })
      : Promise.resolve([] as RuleRow[]),
  ])

  const covered = new Set(level1.map((rule) => rule.signal))
  const rules = [
    ...level1.map(toFeedbackRule),
    ...level2.filter((rule) => !covered.has(rule.signal)).map(toFeedbackRule),
  ]

  if (stats.produced === 0 && rules.length === 0) return null
  return { goalName: goal.name, stats, skipReasons, rules }
}
