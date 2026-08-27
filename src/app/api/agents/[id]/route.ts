import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope, executionVisibilityScope } from '@/lib/server/visibility'
import { goalReadWhere } from '@/lib/server/goal-scope'
import { serializeAgent } from '@/lib/agents/serialize'
import { computeAgentKpis, type AgentRunTally } from '@/lib/agents/roster-stats'
import { AGENT_REQUEST_SELECT, serializeAgentRequest } from '@/lib/agents/request-serialize'

export const runtime = 'nodejs'

const agentIdFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-1) ?? '')

/**
 * One agent, as a teammate's profile: who it is, how it has performed, what
 * people have asked it, and which goals its work has landed on.
 *
 * KPIs are org-wide counts (the same rule /api/agents/stats applies — counts
 * are not content), but the recent-run LIST is visibility-scoped, because a
 * run's title can carry another person's data.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = agentIdFrom(request.nextUrl.pathname)
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, agentType: { not: 'SYSTEM' }, ...agentReadScope(auth.dbUser.id) },
    include: { externalBinding: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const [tallies, contributions, runs, requests, contributedGoalIds, worker] = await Promise.all([
    prisma.agentExecution.groupBy({
      by: ['status'],
      where: { organizationId: auth.organizationId, agentTaskId: id },
      _count: { _all: true },
    }),
    prisma.goalContribution.findMany({
      where: { organizationId: auth.organizationId, resourceType: 'agent', resourceId: id },
      select: { estimatedMinutesSavedPerRun: true, estimateEdited: true, createdAt: true },
    }),
    prisma.agentExecution.findMany({
      where: { organizationId: auth.organizationId, agentTaskId: id, ...executionVisibilityScope(auth.dbUser.id) },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: { id: true, status: true, startedAt: true, completedAt: true, trigger: true, metadata: true },
    }),
    prisma.agentRequest.findMany({
      where: { organizationId: auth.organizationId, agentTaskId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: AGENT_REQUEST_SELECT,
    }),
    prisma.goalContribution.findMany({
      where: { organizationId: auth.organizationId, resourceType: 'agent', resourceId: id },
      select: { goalId: true },
      distinct: ['goalId'],
    }),
    agent.workerId
      ? prisma.agentWorker.findFirst({ where: { id: agent.workerId, organizationId: auth.organizationId }, select: { id: true, name: true } })
      : Promise.resolve(null),
  ])

  const goalIds = contributedGoalIds.map((row) => row.goalId)
  const goals = goalIds.length
    ? await prisma.goal.findMany({
        where: { id: { in: goalIds }, organizationId: auth.organizationId, ...goalReadWhere(auth.dbUser.id, { isAdmin: auth.isAdmin }) },
        select: { id: true, name: true, status: true },
      })
    : []

  return {
    success: true,
    agent: serializeAgent(agent),
    worker,
    kpis: computeAgentKpis({
      tallies: tallies.map((row): AgentRunTally => ({ status: row.status, count: row._count._all })),
      contributions,
    }),
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      triggerType: (run.trigger as { type?: string } | null)?.type ?? 'manual',
      headline: (run.metadata as { headline?: string } | null)?.headline ?? null,
    })),
    requests: requests.map(serializeAgentRequest),
    goals,
  }
}, { requires: 'member' })
