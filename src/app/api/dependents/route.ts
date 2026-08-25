import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { credentialDependents } from '@/lib/dependencies/credential-dependents'
import { flowReadScope } from '@/lib/server/visibility'

export const runtime = 'nodejs'

/**
 * GET /api/dependents?ref=<credential id | connection id | mcp row id>
 *
 * What breaks if this is revoked. Backs the confirmation on a delete button,
 * so it answers for BOTH flows and agents in one call — a dialog that checks
 * only flows is worse than one that checks nothing, because it reads as an
 * all-clear.
 *
 * Read-scoped like the credentials tab: the count must not reveal the
 * existence of work the caller cannot otherwise see. That means the number can
 * under-report for a non-owner, which is the right trade — the alternative
 * leaks flow names across a visibility boundary.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const { ref } = z.object({ ref: z.string().min(1) }).parse({
    ref: request.nextUrl.searchParams.get('ref') ?? '',
  })

  const [flows, connectors] = await Promise.all([
    prisma.flow.findMany({
      where: { organizationId: auth.organizationId, AND: [flowReadScope(auth.dbUser.id)] },
      // Both graphs: an active flow RUNS publishedGraph, so a credential only
      // referenced there is still load-bearing.
      select: { id: true, name: true, graph: true, publishedGraph: true },
      take: 500,
    }),
    prisma.agentConnector.findMany({
      where: { organizationId: auth.organizationId },
      select: {
        agentTaskId: true,
        connectorKey: true,
        kind: true,
        mcpConnectionId: true,
        agentTask: { select: { description: true, metadata: true } },
      },
      take: 1000,
    }),
  ])

  const result = credentialDependents(
    {
      flows,
      agentConnectors: connectors.map((row) => {
        const metadata = row.agentTask?.metadata
        const title =
          metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as { title?: unknown }).title
            : undefined
        return {
          agentTaskId: row.agentTaskId,
          // Agents carry their display name in metadata.title, falling back to
          // the description's first line — the same resolution the roster uses.
          agentName: typeof title === 'string' && title.trim()
            ? title
            : (row.agentTask?.description ?? '').split('\n')[0] || 'Untitled agent',
          connectorKey: row.connectorKey,
          kind: row.kind,
          mcpConnectionId: row.mcpConnectionId,
        }
      }),
    },
    ref,
  )

  return { success: true as const, ...result }
}, { requires: 'member' })
