import { prisma } from '@/lib/prisma'
import { cached } from '@/lib/cache'
import { serializeAgent } from '@/lib/agents/serialize'
import { isUsageExemptEmail } from '@/lib/usage/budget'
import { entitlementPlanFor, isGrandfatheredOrganization } from '@/lib/billing/entitlements'
import { agentReadScope } from '@/lib/server/visibility'
import type { AuthContext } from '@/lib/server/auth'

/**
 * Read the small, shared shell model used by the sidebar, notification bell,
 * and Agent HQ roster. Run history deliberately is not part of this response:
 * it is user-visible only after an agent is selected and is loaded by the
 * dedicated /api/agents/activity endpoint.
 */
export async function readShellSnapshot(auth: AuthContext) {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const notificationScope = { organizationId: auth.organizationId, OR: [{ userId: auth.dbUser.id }, { userId: null }] }

  const [agents, usageAggregate, organization, notifications, unread] = await Promise.all([
    prisma.agentTask.findMany({
      where: {
        organizationId: auth.organizationId,
        status: { not: 'DELETED' },
        agentType: { not: 'SYSTEM' },
        ...agentReadScope(auth.dbUser.id),
      },
      // Avoid transferring lastResult (which can be a large artifact) and
      // unrelated relation columns just to paint the roster.
      select: {
        id: true,
        description: true,
        objective: true,
        goal: true,
        metadata: true,
        folder: true,
        visibility: true,
        status: true,
        schedule: true,
        createdAt: true,
        updatedAt: true,
        lastExecutedAt: true,
        executionCount: true,
        userId: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 300,
    }),
    // Cached 60s per org: this paints a usage meter on every shell poll
    // (~1 req/15s/user), and uncached it re-scanned the org's entire month of
    // executions on each poll — cost that grew with tenant age all month.
    cached(`snapshot:usage:${auth.organizationId}:${monthStart.toISOString().slice(0, 7)}`, 60_000, () =>
      prisma.agentExecution.aggregate({
        where: { organizationId: auth.organizationId, startedAt: { gte: monthStart } },
        _sum: { inputTokens: true, outputTokens: true },
        _count: true,
      }),
    ),
    prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { id: true, name: true, slug: true, plan: true, logoUrl: true, createdAt: true, grandfatheredAt: true },
    }),
    prisma.notification.findMany({ where: notificationScope, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: { ...notificationScope, readAt: null } }),
  ])

  return {
    success: true as const,
    agents: agents.map((agent) => ({ ...serializeAgent(agent), isOwner: agent.userId === auth.dbUser.id })),
    // Kept as an empty compatibility field while clients move to the scoped
    // activity endpoint. This avoids a 150-row run-history payload on login.
    activities: [],
    usage: {
      since: monthStart.toISOString(),
      executions: usageAggregate._count,
      inputTokens: usageAggregate._sum.inputTokens || 0,
      outputTokens: usageAggregate._sum.outputTokens || 0,
      exempt: isUsageExemptEmail(auth.dbUser.email) || isGrandfatheredOrganization(organization),
    },
    activeOrganizationId: auth.organizationId,
    organizations: organization ? [{ ...organization, plan: entitlementPlanFor(organization) }] : [],
    notifications,
    unread,
  }
}
