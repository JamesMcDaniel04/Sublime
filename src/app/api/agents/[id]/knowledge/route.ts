import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope, agentWriteScope } from '@/lib/server/visibility'
import { ingestUploadedFile, MAX_UPLOAD_BODY_BYTES } from '@/lib/knowledge/upload'

export const runtime = 'nodejs'

/**
 * Resolve the agent id from the path and enforce access.
 *
 * `access` matters once agents can be org-shared: 'read' lets a viewer list this
 * agent's rows, while any mutation demands 'write' so an org_viewer can never
 * change someone else's agent.
 */
async function requireAgent(
  request: Request,
  auth: { organizationId: string; dbUser: { id: string } },
  access: 'read' | 'write' = 'write',
) {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const agent = await prisma.agentTask.findFirst({
    where: {
      id,
      organizationId: auth.organizationId,
      status: { not: 'DELETED' },
      ...(access === 'write' ? agentWriteScope(auth.dbUser.id) : agentReadScope(auth.dbUser.id)),
    },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return agent.id
}

function serializeDoc(doc: { id: string; filename: string; mimeType: string; sizeBytes: number; charCount: number; status: string; createdAt: Date; _count?: { chunks: number } }) {
  return {
    id: doc.id,
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    charCount: doc.charCount,
    status: doc.status,
    chunkCount: doc._count?.chunks ?? 0,
    createdAt: doc.createdAt,
  }
}

// GET — list this agent's knowledge documents.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth, 'read')
  const docs = await prisma.knowledgeDocument.findMany({
    where: { organizationId: auth.organizationId, agentId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { chunks: true } } },
    take: 100,
  })
  return { success: true, documents: docs.map(serializeDoc) }
}, { requires: 'member' })

// POST — upload a file (multipart form-data, field "file") as knowledge.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth)
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) throw new ApiError('Attach a file in the "file" field.')
  // Size cap, malware scan, signature check, and extraction all live in the
  // shared upload path (lib/knowledge/upload.ts) with the workspace repository.
  const document = await ingestUploadedFile(file, { organizationId: auth.organizationId, userId: auth.dbUser.id, agentId })
  return { success: true, document }
  // Each upload fans out into chunking + embedding generation — throttled so a
  // scripted loop can't turn the embedding pipeline into a cost hole.
}, {
  requires: 'member',
  rateLimit: { feature: 'knowledge-upload', perUser: 20 },
  maxBodyBytes: MAX_UPLOAD_BODY_BYTES,
})

// DELETE — remove a knowledge document (and its chunks, via cascade).
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth)
  const { documentId } = z.object({ documentId: z.string().min(1) }).parse(await request.json())
  const result = await prisma.knowledgeDocument.deleteMany({
    where: { id: documentId, organizationId: auth.organizationId, agentId },
  })
  if (!result.count) throw new ApiError('Document not found', 404, 'NOT_FOUND')
  return { success: true }
}, { requires: 'member' })
