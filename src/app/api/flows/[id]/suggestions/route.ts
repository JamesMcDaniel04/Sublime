import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope } from '@/lib/server/visibility'
import { orgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'
import { FLOW_TARGET_MARKER_PREFIX } from '@/lib/intelligence/suggest-workflows'

/**
 * Improvement suggestions for one flow (behavioral-intelligence Task 3).
 * These are 'suggestion'-kind AgentMemory rows saved under the org's hidden
 * shared intelligence agent (not this flow — AgentMemory.agentId is an
 * AgentTask FK, and a Flow is not one), with the target flow id carried in
 * the otherwise-unused `question` field as `flow:<id>` — see
 * suggest-workflows.ts for why that's safe (never rendered; only ever set on
 * the hidden holder agent's own memories).
 */

async function requireFlow(request: Request, auth: { organizationId: string; dbUser: { id: string } }) {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return flow.id
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const flowId = await requireFlow(request, auth)
  const agentId = await orgIntelligenceAgentId(auth.organizationId)
  const memories = await prisma.agentMemory.findMany({
    where: {
      organizationId: auth.organizationId,
      agentId,
      kind: 'suggestion',
      status: 'open',
      question: `${FLOW_TARGET_MARKER_PREFIX}${flowId}`,
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, title: true, content: true },
  })
  return { success: true, suggestions: memories }
}, { requires: 'member' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const flowId = await requireFlow(request, auth)
  const agentId = await orgIntelligenceAgentId(auth.organizationId)
  const { id, status } = z.object({ id: z.string(), status: z.enum(['dismissed', 'accepted', 'open']) }).parse(await request.json())
  const updated = await prisma.agentMemory.updateMany({
    where: { id, organizationId: auth.organizationId, agentId, question: `${FLOW_TARGET_MARKER_PREFIX}${flowId}` },
    data: { status },
  })
  if (updated.count !== 1) throw new ApiError('Suggestion not found', 404, 'NOT_FOUND')
  return { success: true }
}, { requires: 'member' })
