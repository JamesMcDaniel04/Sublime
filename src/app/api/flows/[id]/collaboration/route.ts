import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope, flowWriteScope } from '@/lib/server/visibility'
import { flowGraphSchema } from '@/lib/flows/graph'
import { inlineLiteralSecretNodes } from '@/lib/flows/inline-auth'
import {
  applyFlowCollaborationPatch,
  flowCollaborationPatchSchema,
  patchChangesTopology,
} from '@/lib/flows/collaboration'
import { appendMutation, hasAppliedMutation } from '@/lib/flows/mutation-log'

export const runtime = 'nodejs'

const postSchema = z.object({
  baseRevision: z.number().int().min(0),
  patch: flowCollaborationPatchSchema,
})
const MAX_REQUEST_BYTES = 512 * 1024

function channelTopic(flowId: string, organizationId: string, accessRevision: number): string {
  const secret = process.env.ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new ApiError('Flow collaboration is not configured', 503, 'COLLABORATION_NOT_CONFIGURED')
  }
  const signature = crypto
    .createHmac('sha256', secret || 'sublime-local-collaboration')
    .update(`${organizationId}:${flowId}:${accessRevision}`)
    .digest('base64url')
    .slice(0, 24)
  return `flow-jam:${flowId}:${accessRevision}:${signature}`
}

/**
 * `access: 'read'` — may JOIN the session: load the graph + private topic and
 * watch teammates' cursors/edits live. Granted to the owner, invited
 * collaborators, and any org share (viewer or editor).
 *
 * `access: 'write'` — may CHANGE the graph (apply a patch). Owner, invited
 * collaborators, and org_editor only, so an org_viewer can observe a jam without
 * being able to mutate someone else's flow.
 */
async function collaborationFlow(id: string, organizationId: string, userId: string, access: 'read' | 'write') {
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId, ...(access === 'write' ? flowWriteScope(userId) : flowReadScope(userId)) },
    select: {
      id: true,
      userId: true,
      graph: true,
      collaborationRevision: true,
      collaborationAccessRevision: true,
      collaborationMutationLog: true,
      updatedAt: true,
    },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return flow
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await collaborationFlow(id, auth.organizationId, auth.dbUser.id, 'read')
  return {
    success: true,
    topic: channelTopic(flow.id, auth.organizationId, flow.collaborationAccessRevision),
    actor: {
      userId: auth.dbUser.id,
      name: auth.dbUser.name || auth.dbUser.email || 'Teammate',
    },
    graph: flowGraphSchema.parse(flow.graph),
    revision: flow.collaborationRevision,
    updatedAt: flow.updatedAt.toISOString(),
    canManageJam: flow.userId === auth.dbUser.id,
  }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
    throw new ApiError('Collaboration patch is too large', 413, 'PATCH_TOO_LARGE')
  }
  const input = postSchema.parse(JSON.parse(rawBody))

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const flow = await collaborationFlow(id, auth.organizationId, auth.dbUser.id, 'write')
    const graph = flowGraphSchema.parse(flow.graph)

    // Idempotent replay: a retried POST (client timeout, flaky network) whose
    // patch already landed returns the current state without re-applying it —
    // no double-apply, no duplicate conflict reports.
    if (hasAppliedMutation(flow.collaborationMutationLog, input.patch.mutationId)) {
      return {
        success: true,
        graph,
        revision: flow.collaborationRevision,
        updatedAt: flow.updatedAt.toISOString(),
        conflicts: [],
      }
    }

    if (input.baseRevision !== flow.collaborationRevision && patchChangesTopology(input.patch)) {
      return NextResponse.json(
        {
          success: false,
          error: 'The flow structure changed while you were editing. The latest shared version has been restored; please retry your structural change.',
          code: 'FLOW_TOPOLOGY_CONFLICT',
          graph,
          revision: flow.collaborationRevision,
          updatedAt: flow.updatedAt.toISOString(),
        },
        { status: 409 },
      )
    }

    const applied = applyFlowCollaborationPatch(graph, input.patch)
    if (inlineLiteralSecretNodes(applied.graph).length) {
      throw new ApiError(
        'Inline secrets must be saved as a private credential before this flow can be saved.',
        400,
        'INLINE_AUTH_SECRET',
      )
    }
    if (JSON.stringify(applied.graph) === JSON.stringify(graph)) {
      return {
        success: true,
        graph,
        revision: flow.collaborationRevision,
        updatedAt: flow.updatedAt.toISOString(),
        conflicts: applied.conflicts,
      }
    }

    const [updated] = await prisma.flow.updateManyAndReturn({
      where: {
        id,
        organizationId: auth.organizationId,
        collaborationRevision: flow.collaborationRevision,
        ...flowWriteScope(auth.dbUser.id),
      },
      data: {
        graph: JSON.parse(JSON.stringify(applied.graph)),
        collaborationRevision: { increment: 1 },
        collaborationMutationLog: appendMutation(flow.collaborationMutationLog, input.patch.mutationId),
      },
      select: {
        graph: true,
        collaborationRevision: true,
        updatedAt: true,
      },
    })
    if (!updated) continue
    return {
      success: true,
      graph: flowGraphSchema.parse(updated.graph),
      revision: updated.collaborationRevision,
      updatedAt: updated.updatedAt.toISOString(),
      conflicts: applied.conflicts,
    }
  }

  throw new ApiError('Flow collaboration is busy; retry the edit', 503, 'COLLABORATION_BUSY')
}, { requires: 'member' })
