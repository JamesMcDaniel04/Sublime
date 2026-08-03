import { prisma } from '@/lib/prisma'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { agentReadScope, executionVisibilityScope, flowReadScope } from '@/lib/server/visibility'

/**
 * Server-side context assembly for the Home assistant: a compact, bounded
 * snapshot of everything going on in the workspace (agents, recent runs,
 * connections, flows) that the model grounds its answers in. Long values are
 * clipped so one big run output cannot blow the prompt budget.
 */

function clip(value: unknown, max = 300): string | null {
  if (value == null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return null
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

export type WorkspaceContext = {
  agents: Array<{
    id: string
    title: string
    description: string
    status: string
    schedule: unknown
    integrations: string[]
    lastExecutedAt: string | null
  }>
  recentRuns: Array<{
    id: string
    agentTitle: string
    status: string
    startedAt: string
    headline: string | null
    error: string | null
  }>
  // Connections are reported from the two stores that actually hold live
  // connections: Nango (OAuth providers) and MCP servers. An earlier `oauth`
  // map came from the legacy `Integration` table, which nothing writes — it
  // asserted `connected: false` for every provider, telling the model a
  // connected workspace was empty. Nango already covers the same providers
  // truthfully, so the map was both wrong and redundant.
  connections: {
    nango: Array<{ provider: string; status: string; error: string | null }>
    mcp: Array<{ name: string; provider: string | null; verified: boolean }>
  }
  flows: Array<{ id: string; name: string; status: string }>
}

export async function buildWorkspaceContext(auth: {
  organizationId: string
  dbUser: { id: string }
}): Promise<WorkspaceContext> {
  const { organizationId } = auth
  const userId = auth.dbUser.id

  const [agents, runs, flows, nango, mcp] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId, status: { not: 'DELETED' }, ...agentReadScope(userId) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    prisma.agentExecution.findMany({
      where: { organizationId, ...executionVisibilityScope(userId) },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: { id: true, status: true, startedAt: true, error: true, metadata: true },
    }),
    prisma.flow.findMany({
      where: { organizationId, ...flowReadScope(userId) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, name: true, status: true },
    }),
    prisma.nangoConnection.findMany({
      where: { organizationId },
      select: { providerConfigKey: true, status: true, lastError: true },
    }),
    prisma.mcpConnection.findMany({
      where: { organizationId, isActive: true, OR: [{ userId: null }, { userId }] },
      select: { name: true, provider: true, lastVerifiedAt: true },
    }),
  ])

  return {
    agents: agents.map((agent) => {
      const metadata = readAgentMetadata(agent.metadata)
      return {
        id: agent.id,
        title: metadata.title || agent.description,
        description: clip(metadata.description || agent.description) || '',
        status: agent.status,
        schedule: agent.schedule,
        integrations: metadata.integrations || [],
        lastExecutedAt: agent.lastExecutedAt ? agent.lastExecutedAt.toISOString() : null,
      }
    }),
    recentRuns: runs.map((run) => {
      const metadata =
        run.metadata && typeof run.metadata === 'object' && !Array.isArray(run.metadata)
          ? (run.metadata as Record<string, unknown>)
          : {}
      return {
        id: run.id,
        agentTitle: typeof metadata.title === 'string' ? metadata.title : 'Agent',
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        headline: typeof metadata.headline === 'string' ? metadata.headline : null,
        error: clip(run.error),
      }
    }),
    connections: {
      nango: nango.map((row) => ({
        provider: row.providerConfigKey,
        status: row.status,
        error: clip(row.lastError, 160),
      })),
      mcp: mcp.map((row) => ({ name: row.name, provider: row.provider, verified: Boolean(row.lastVerifiedAt) })),
    },
    flows: flows.map((flow) => ({ id: flow.id, name: flow.name, status: flow.status })),
  }
}
