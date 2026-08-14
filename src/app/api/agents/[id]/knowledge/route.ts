import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope, agentWriteScope } from '@/lib/server/visibility'
import { ingestKnowledgeFile, UnsupportedFileError } from '@/lib/knowledge/ingest'
import { MalwareDetectedError, scanUpload } from '@/lib/security/scan-upload'
import { recordSecurityEvent } from '@/lib/security/alerts'
import { FileSignatureError } from '@/lib/security/file-signature'

export const runtime = 'nodejs'

// Max upload size for a knowledge file (pre-extraction).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB

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
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError('File is too large (max 10 MB).', 413, 'TOO_LARGE')

  const buffer = Buffer.from(await file.arrayBuffer())

  // Before ingestion: the extractor hands these bytes to pdf-parse or mammoth
  // in-process, so scanning has to happen while the file is still just bytes.
  // No-ops unless UPLOAD_SCANNER_URL is configured.
  try {
    await scanUpload(buffer, file.name || 'upload')
  } catch (error) {
    if (error instanceof MalwareDetectedError) {
      // Threshold is 1: a confirmed hit means somebody deliberately uploaded
      // something, which is always worth knowing the same day.
      recordSecurityEvent({
        kind: 'malware.detected',
        source: auth.dbUser.id,
        organizationId: auth.organizationId,
        detail: { verdict: error.message },
      })
      throw new ApiError(error.message, 422, 'MALWARE_DETECTED', error)
    }
    throw error
  }

  try {
    const document = await ingestKnowledgeFile({
      organizationId: auth.organizationId,
      agentId,
      userId: auth.dbUser.id,
      filename: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
      buffer,
    })
    return { success: true, document }
  } catch (error) {
    if (error instanceof UnsupportedFileError) throw new ApiError(error.message, 415, 'UNSUPPORTED_TYPE')
    // Bytes that contradict the declared type: a rejected upload, not a
    // corrupt one. Distinguishing them tells a user who picked the wrong file
    // something they can act on.
    if (error instanceof FileSignatureError) throw new ApiError(error.message, 415, 'UNSUPPORTED_TYPE', error)
    throw error
  }
  // Each upload fans out into chunking + embedding generation — throttled so a
  // scripted loop can't turn the embedding pipeline into a cost hole.
}, {
  requires: 'member',
  rateLimit: { feature: 'knowledge-upload', perUser: 20 },
  // Matches the 10 MB MAX_UPLOAD_BYTES with multipart headroom.
  maxBodyBytes: 12 * 1024 * 1024,
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
