import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope } from '@/lib/server/visibility'
import { decryptKnowledgeContent } from '@/lib/knowledge/store'
import { knowledgeCaptureSettings } from '@/lib/knowledge/settings'

export const dynamic = 'force-dynamic'

async function visibleKnowledgeScope(organizationId: string, userId: string) {
  const agents = await prisma.agentTask.findMany({
    where: { organizationId, status: { not: 'DELETED' }, ...agentReadScope(userId) },
    select: { id: true },
  })
  return {
    organizationId,
    OR: [
      { visibility: 'organization' },
      { userId },
      { visibility: 'agent', agentId: { in: agents.map((agent) => agent.id) } },
    ],
  }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const scope = await visibleKnowledgeScope(auth.organizationId, auth.dbUser.id)
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { settings: true },
  })
  const wantDownload = new URL(request.url).searchParams.get('download') === '1'
  // The list never renders document bodies, but `include` fetched every
  // scalar — up to 250 full encrypted corpora into lambda memory per page
  // view. `contentEncrypted` is loaded only on the explicit download branch.
  const docs = await prisma.knowledgeDocument.findMany({
    where: scope,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      filename: true,
      sourceType: true,
      sourceId: true,
      visibility: true,
      provenance: true,
      charCount: true,
      lastSyncedAt: true,
      createdAt: true,
      updatedAt: true,
      ...(wantDownload ? { contentEncrypted: true } : {}),
      _count: { select: { chunks: true } },
    },
    take: 250,
  })

  if (wantDownload) {
    const exported = docs.map((doc) => ({
      id: doc.id,
      title: doc.title || doc.filename,
      filename: doc.filename,
      sourceType: doc.sourceType,
      sourceId: doc.sourceId,
      visibility: doc.visibility,
      provenance: doc.provenance,
      content: decryptKnowledgeContent((doc as { contentEncrypted?: string }).contentEncrypted ?? ''),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }))
    return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), documents: exported }, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="sublime-knowledge-${new Date().toISOString().slice(0, 10)}.json"`,
        'Cache-Control': 'private, no-store',
      },
    })
  }

  const bySource = docs.reduce<Record<string, number>>((counts, doc) => {
    counts[doc.sourceType] = (counts[doc.sourceType] ?? 0) + 1
    return counts
  }, {})
  return {
    success: true,
    settings: knowledgeCaptureSettings(organization?.settings),
    summary: {
      documents: docs.length,
      characters: docs.reduce((sum, doc) => sum + doc.charCount, 0),
      passages: docs.reduce((sum, doc) => sum + doc._count.chunks, 0),
      bySource,
    },
    documents: docs.slice(0, 50).map((doc) => ({
      id: doc.id,
      title: doc.title || doc.filename,
      filename: doc.filename,
      sourceType: doc.sourceType,
      visibility: doc.visibility,
      charCount: doc.charCount,
      passageCount: doc._count.chunks,
      lastSyncedAt: doc.lastSyncedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    })),
  }
}, { requires: 'member' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { documentId } = z.object({ documentId: z.string().min(1) }).parse(await request.json())
  const doc = await prisma.knowledgeDocument.findFirst({
    where: { id: documentId, organizationId: auth.organizationId },
    select: { id: true, userId: true, visibility: true },
  })
  if (!doc) throw new ApiError('Knowledge document not found', 404, 'NOT_FOUND')
  const canDelete = doc.userId === auth.dbUser.id || (auth.dbUser.role === 'ADMIN' && doc.visibility === 'organization')
  if (!canDelete) throw new ApiError('You cannot delete this knowledge document', 403, 'FORBIDDEN')
  await prisma.knowledgeDocument.delete({ where: { id: doc.id, organizationId: auth.organizationId } })
  return { success: true }
}, { requires: 'member' })
