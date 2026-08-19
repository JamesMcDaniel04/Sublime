import { prisma } from '@/lib/prisma'
import { cached } from '@/lib/cache'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope } from '@/lib/server/visibility'
import { computeAgentKpis, type AgentContributionEstimate, type AgentKpis, type AgentRunTally } from '@/lib/agents/roster-stats'

/** Matches /api/snapshot's roster cap so both surfaces cover the same agents. */
const MAX_ROSTER_AGENTS = 300

/**
 * Per-agent KPIs for the roster tiles.
 *
 * Two deliberate decisions live here.
 *
 * 1. Run counts come from the agent_executions ledger, NOT from
 *    AgentTask.executionCount. That counter is incremented once before a
 *    scheduled run (api/cron/dispatch) and again after a successful one
 *    (execute-agent), so scheduled agents are double-counted. See
 *    lib/agents/roster-stats.ts.
 *
 * 2. The aggregate is ORG-WIDE for every agent the viewer can read, rather than
 *    scoped to runs the viewer started (executionVisibilityScope). That scope
 *    exists to keep run CONTENT private — output can hold another user's data —
 *    and nothing here returns content: only counts. Scoping counts per viewer
 *    would show "no runs yet" on a shared agent whose schedule runs as its
 *    owner, and give two teammates different success rates for the same agent,
 *    which defeats the point of a shared roster. Agents the viewer cannot read
 *    are never included, so this exposes no agent they couldn't already see.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const stats = await cached(
    `agents:stats:${auth.organizationId}:${auth.dbUser.id}`,
    60_000,
    async () => {
      const agents = await prisma.agentTask.findMany({
        where: { organizationId: auth.organizationId, ...agentReadScope(auth.dbUser.id) },
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
        take: MAX_ROSTER_AGENTS,
      })
      const agentIds = agents.map((agent) => agent.id)
      if (agentIds.length === 0) return {}

      const [tallies, contributions] = await Promise.all([
        prisma.agentExecution.groupBy({
          by: ['agentTaskId', 'status'],
          where: { organizationId: auth.organizationId, agentTaskId: { in: agentIds } },
          _count: { _all: true },
        }),
        prisma.goalContribution.findMany({
          where: { organizationId: auth.organizationId, resourceType: 'agent', resourceId: { in: agentIds } },
          select: {
            resourceId: true,
            estimatedMinutesSavedPerRun: true,
            estimateEdited: true,
            createdAt: true,
          },
        }),
      ])

      const talliesByAgent = new Map<string, AgentRunTally[]>()
      for (const row of tallies) {
        if (!row.agentTaskId) continue
        const bucket = talliesByAgent.get(row.agentTaskId) ?? []
        bucket.push({ status: row.status, count: row._count._all })
        talliesByAgent.set(row.agentTaskId, bucket)
      }

      const estimatesByAgent = new Map<string, AgentContributionEstimate[]>()
      for (const row of contributions) {
        const bucket = estimatesByAgent.get(row.resourceId) ?? []
        bucket.push({
          estimatedMinutesSavedPerRun: row.estimatedMinutesSavedPerRun,
          estimateEdited: row.estimateEdited,
          createdAt: row.createdAt,
        })
        estimatesByAgent.set(row.resourceId, bucket)
      }

      // KPIs are computed inside the cached fetcher so only plain numbers are
      // stored — Dates would come back from Redis as strings.
      const computed: Record<string, AgentKpis> = {}
      for (const agentId of agentIds) {
        computed[agentId] = computeAgentKpis({
          tallies: talliesByAgent.get(agentId) ?? [],
          contributions: estimatesByAgent.get(agentId) ?? [],
        })
      }
      return computed
    },
  )

  return { success: true, stats }
}, { requires: 'member' })
