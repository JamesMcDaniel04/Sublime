import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const suggestion = await prisma.userSuggestion.findFirst({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, status: 'open' },
    orderBy: { createdAt: 'desc' },
  })
  return {
    success: true,
    suggestion: suggestion
      ? {
          id: suggestion.id, kind: suggestion.kind, title: suggestion.title,
          description: suggestion.description, flowId: suggestion.flowId,
          targetType: suggestion.targetType, targetId: suggestion.targetId,
          evidence: Array.isArray(suggestion.evidence) ? (suggestion.evidence as string[]) : [],
        }
      : null,
  }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { id, action } = z.object({ id: z.string().min(1), action: z.enum(['accept', 'dismiss']) }).parse(await request.json())
  const suggestion = await prisma.userSuggestion.findFirst({
    where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id, status: 'open' },
  })
  if (!suggestion) throw new ApiError('Suggestion not found', 404, 'NOT_FOUND')

  await prisma.userSuggestion.update({
    where: { id: suggestion.id, organizationId: auth.organizationId },
    data: { status: action === 'accept' ? 'accepted' : 'dismissed' },
  })

  // Accepting an enhancement must make it VISIBLE on its target. Agent
  // targets already got an AgentMemory suggestion at synthesis time; flow
  // targets need one now, tagged the way the flow builder's banner reads
  // them (flow:<id> marker under the hidden org intelligence agent — see
  // /api/flows/[id]/suggestions).
  if (action === 'accept' && suggestion.kind === 'enhancement' && suggestion.targetType === 'flow' && suggestion.targetId) {
    try {
      const { orgIntelligenceAgentId } = await import('@/lib/intelligence/connection-scan')
      const { FLOW_TARGET_MARKER_PREFIX } = await import('@/lib/intelligence/suggest-workflows')
      const { saveAgentMemory } = await import('@/lib/memory/agent-memory')
      const holderAgentId = await orgIntelligenceAgentId(auth.organizationId)
      await saveAgentMemory({
        organizationId: auth.organizationId,
        agentId: holderAgentId,
        kind: 'suggestion',
        title: suggestion.title,
        content: suggestion.description,
        question: `${FLOW_TARGET_MARKER_PREFIX}${suggestion.targetId}`,
      })
    } catch (error) {
      apiLogger.warn('user-suggestions: flow enhancement memory write failed', {
        suggestionId: suggestion.id, error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (action === 'dismiss') {
    // Feedback loop (spec §4): dismissing a suggestion dismisses its source
    // patterns, and the inference job's similarity check suppresses lookalikes.
    const slugs = Array.isArray(suggestion.sourcePatternSlugs) ? (suggestion.sourcePatternSlugs as string[]) : []
    if (slugs.length > 0) {
      await prisma.userPattern.updateMany({
        where: { organizationId: auth.organizationId, userId: auth.dbUser.id, slug: { in: slugs } },
        data: { status: 'dismissed' },
      })
    }
    // A dismissed new_flow suggestion also removes its unreviewed draft.
    if (suggestion.kind === 'new_flow' && suggestion.flowId) {
      await prisma.flow.deleteMany({
        where: { id: suggestion.flowId, organizationId: auth.organizationId, status: 'DRAFT' },
      })
    }
  }

  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: action === 'accept' ? 'suggestion_accepted' : 'suggestion_dismissed',
    resourceType: 'suggestion', resourceId: suggestion.id,
    context: { suggestionKind: suggestion.kind },
  })
  return { success: true }
})
