/**
 * GET /api/settings/insights — workspace activity for admins.
 *
 * Two sections, one request:
 *   adoption      per member: is my team using this, and who needs help?
 *   contribution  per goal: who is moving the numbers?
 *
 * AGGREGATE ONLY — counts, timestamps and names, never the content of a run,
 * prompt or work item. The e2e test pins the response to a key allow-list, so
 * a future field carrying content fails a test rather than shipping.
 *
 * No new capture: UserEvent (bounded kinds, indexed [organizationId,
 * occurredAt]) and GoalWork/GoalContribution already hold everything. Credits
 * are an ORG-WIDE pool (see lib/billing/limits.ts), so there is no per-seat
 * credit figure — per-member spend is AgentExecution tokens grouped by userId,
 * reported as a share of the pool, never as "credits used".
 */
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const WINDOW_DAYS = 30

/** UserEvent kinds that count as a "run" for the adoption table. */
const RUN_KINDS = ['agent_run_manual', 'flow_run_manual']

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const organizationId = auth.organizationId

  const [membersRaw, events, lastActive, tokens, goals, work, contributions] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.userEvent.groupBy({
      by: ['userId', 'kind'],
      where: { organizationId, occurredAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.userEvent.groupBy({
      by: ['userId'],
      where: { organizationId },
      _max: { occurredAt: true },
    }),
    prisma.agentExecution.groupBy({
      by: ['userId'],
      where: { organizationId, startedAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.goal.findMany({
      where: { organizationId, status: 'active', ownerUserId: null },
      select: { id: true, name: true, riskLevel: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.goalWork.groupBy({
      by: ['goalId', 'disposition'],
      where: { organizationId },
      _count: { _all: true },
    }),
    prisma.goalContribution.groupBy({
      by: ['goalId'],
      where: { organizationId },
      _count: { _all: true },
    }),
  ])

  const countFor = (userId: string, kinds: string[]) =>
    events
      .filter((row) => row.userId === userId && kinds.includes(row.kind))
      .reduce((total, row) => total + row._count._all, 0)
  const lastFor = new Map(lastActive.map((row) => [row.userId, row._max.occurredAt] as const))
  const tokensFor = new Map(
    tokens.map((row) => [row.userId, (row._sum.inputTokens || 0) + (row._sum.outputTokens || 0)] as const),
  )

  // Every active member appears, INCLUDING the never-active: an absent row
  // reads as a rendering bug, and the whole point is surfacing who needs help.
  const adoption = membersRaw.map((member) => ({
    userId: member.id,
    name: member.name,
    email: member.email,
    lastActiveAt: lastFor.get(member.id) ?? null,
    runs: countFor(member.id, RUN_KINDS),
    flowsCreated: countFor(member.id, ['flow_created']),
    agentsCreated: countFor(member.id, ['agent_created']),
    tokensUsed: tokensFor.get(member.id) ?? 0,
  }))

  const workFor = (goalId: string, disposition: string) =>
    work.find((row) => row.goalId === goalId && row.disposition === disposition)?._count._all ?? 0
  const contributionFor = new Map(contributions.map((row) => [row.goalId, row._count._all] as const))

  const contribution = goals.map((goal) => ({
    goalId: goal.id,
    name: goal.name,
    riskLevel: goal.riskLevel,
    contributions: contributionFor.get(goal.id) ?? 0,
    pending: workFor(goal.id, 'pending'),
    used: workFor(goal.id, 'used') + workFor(goal.id, 'edited'),
    skipped: workFor(goal.id, 'skipped'),
  }))

  const neverActive = adoption.filter((row) => row.lastActiveAt === null).length

  return {
    success: true,
    windowDays: WINDOW_DAYS,
    adoption,
    contribution,
    headline: { members: adoption.length, neverActive },
  }
}, { requires: 'insights:workspace' })
