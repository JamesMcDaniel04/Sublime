import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { outdatedNodes, migrateGraph } from '@/lib/flows/node-versions'
import type { Prisma } from '@/generated/prisma/client'

/**
 * Reporting and applying node-version migrations for one flow.
 *
 * Upgrading is an explicit act, which is the entire point of pinning versions.
 * A flow that opens is never silently rewritten: GET says what is behind, and
 * POST changes it only when someone asks.
 *
 * **Only the draft graph is migrated.** `publishedGraph` is what scheduled and
 * triggered runs execute, and rewriting it here would change what production
 * does without anyone reviewing the change — the same reasoning that keeps the
 * form trigger and the public API on published graphs only. An upgraded flow
 * takes effect in production when someone publishes it, deliberately.
 */

/** The flow id sits before `/migrate` in the path. */
function flowIdOf(request: Request): string {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required', 400, 'BAD_REQUEST')
  return id
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const flow = await prisma.flow.findFirst({
    where: { id: flowIdOf(request), organizationId: auth.organizationId },
    select: { id: true, graph: true, publishedGraph: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const draft = outdatedNodes((flow.graph ?? {}) as { nodes?: unknown })
  return {
    success: true,
    outdated: draft,
    // Reported separately so the UI can say "your draft is current, but what
    // is RUNNING is not" — the more useful and more alarming of the two.
    publishedOutdated: flow.publishedGraph
      ? outdatedNodes(flow.publishedGraph as { nodes?: unknown })
      : [],
  }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const flow = await prisma.flow.findFirst({
    where: { id: flowIdOf(request), organizationId: auth.organizationId },
    select: { id: true, graph: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const { graph, migrated } = migrateGraph((flow.graph ?? { nodes: [], edges: [] }) as { nodes?: unknown })
  if (migrated.length === 0) return { success: true, migrated: [] }

  await prisma.flow.updateMany({
    where: { id: flow.id, organizationId: auth.organizationId },
    data: { graph: graph as Prisma.InputJsonValue },
  })

  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.nodes.migrated',
    resourceType: 'flow',
    resourceId: flow.id,
    detail: { migrated },
  })

  return {
    success: true,
    migrated,
    // Said plainly, because the gap between "migrated" and "live" is exactly
    // where someone assumes the upgrade already took effect.
    note: 'Publish this flow for the upgrade to affect scheduled and triggered runs.',
  }
}, { requires: 'member' })
