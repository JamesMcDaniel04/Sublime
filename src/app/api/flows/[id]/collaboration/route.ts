import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowVisibilityScope } from '@/lib/server/visibility'
import { flowGraphSchema } from '@/lib/flows/graph'
import {
  applyFlowCollaborationPatch,
  flowCollaborationPatchSchema,
  patchChangesTopology,
} from '@/lib/flows/collaboration'

export const runtime = 'nodejs'

const postSchema = z.object({
  baseRevision: z.number().int().min(0),
  patch: flowCollaborationPatchSchema,
})
const MAX_REQUEST_BYTES = 512 * 1024

function channelTopic(flowId: string, organizationId: string): string {
  const secret = process.env.ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new ApiError('Flow collaboration is not configured', 503, 'COLLABORATION_NOT_CONFIGURED')
  }
  const signature = crypto
    .createHmac('sha256', secret || 'sublime-local-collaboration')
    .update(`${organizationId}:${flowId}`)
    .digest('base64url')
    .slice(0, 24)
  return `flow-jam:${flowId}:${signature}`
}

async function collaborationFlow(id: string, organizationId: string, userId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId, ...flowVisibilityScope(userId) },
    select: {
      id: true,
      userId: true,
      graph: true,
      collaborationRevision: true,
      updatedAt: true,
    },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return flow
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await collaborationFlow(id, auth.organizationId, auth.dbUser.id)
  return {
    success: true,
    topic: channelTopic(flow.id, auth.organizationId),
    actor: {
      userId: auth.dbUser.id,
      name: auth.dbUser.name || auth.dbUser.email || 'Teammate',
    },
    graph: flowGraphSchema.parse(flow.graph),
    revision: flow.collaborationRevision,
    updatedAt: flow.updatedAt.toISOString(),
    canManageJam: flow.userId === auth.dbUser.id,
  }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
    throw new ApiError('Collaboration patch is too large', 413, 'PATCH_TOO_LARGE')
  }
  const input = postSchema.parse(JSON.parse(rawBody))

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const flow = await collaborationFlow(id, auth.organizationId, auth.dbUser.id)
    const graph = flowGraphSchema.parse(flow.graph)

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
        ...flowVisibilityScope(auth.dbUser.id),
      },
      data: {
        graph: JSON.parse(JSON.stringify(applied.graph)),
        collaborationRevision: { increment: 1 },
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
})
