import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { decryptKnowledgeContent } from '@/lib/knowledge/store'
import { knowledgeCaptureSettings } from '@/lib/knowledge/settings'
import { createWorkspaceNote, REPOSITORY_SOURCE_TYPES, viewerKnowledgeScope } from '@/lib/knowledge/files'
import { ingestUploadedFile, MAX_UPLOAD_BODY_BYTES } from '@/lib/knowledge/upload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_NOTE_CHARS = 200_000

export const GET = withAuthenticatedApi(async (request, auth) => {
  const scope = await viewerKnowledgeScope(auth.organizationId, auth.dbUser.id)
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { settings: true },
  })
  const params = new URL(request.url).searchParams
  const wantDownload = params.get('download') === '1'
  // `source=repository` is the /knowledge page: only files people put there
  // (uploads + notes), all of them. The default keeps the settings card's
  // summary shape — every source, first 50.
  const repositoryOnly = params.get('source') === 'repository'
  // The list never renders document bodies, but `include` fetched every
  // scalar — up to 250 full encrypted corpora into lambda memory per page
  // view. `contentEncrypted` is loaded only on the explicit download branch.
  const docs = await prisma.knowledgeDocument.findMany({
    where: repositoryOnly ? { AND: [scope, { sourceType: { in: [...REPOSITORY_SOURCE_TYPES] } }] } : scope,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      sourceType: true,
      sourceId: true,
      visibility: true,
      userId: true,
      agentId: true,
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
  const isAdmin = auth.dbUser.role === 'ADMIN'
  return {
    success: true,
    settings: knowledgeCaptureSettings(organization?.settings),
    summary: {
      documents: docs.length,
      characters: docs.reduce((sum, doc) => sum + doc.charCount, 0),
      passages: docs.reduce((sum, doc) => sum + doc._count.chunks, 0),
      bySource,
    },
    documents: (repositoryOnly ? docs : docs.slice(0, 50)).map((doc) => ({
      id: doc.id,
      title: doc.title || doc.filename,
      filename: doc.filename,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      sourceType: doc.sourceType,
      visibility: doc.visibility,
      agentId: doc.agentId,
      charCount: doc.charCount,
      passageCount: doc._count.chunks,
      // Same rule DELETE and PUT enforce, so the page only offers what will succeed.
      canEdit: doc.userId === auth.dbUser.id || (isAdmin && doc.visibility === 'organization'),
      lastSyncedAt: doc.lastSyncedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    })),
  }
}, { requires: 'member' })

const noteSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().min(1).max(MAX_NOTE_CHARS),
  visibility: z.enum(['organization', 'private']).default('organization'),
})

// POST — add a file to the workspace repository. Two bodies:
//   multipart/form-data with `file` (+ optional `visibility`) uploads a document;
//   JSON { title, content, visibility? } writes a Markdown note in place.
// Either lands as a KnowledgeDocument every agent (or, when private, only the
// author's runs) can retrieve and read by name.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) throw new ApiError('Attach a file in the "file" field.')
    const visibility = form?.get('visibility') === 'private' ? 'private' : 'organization'
    const document = await ingestUploadedFile(file, {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      agentId: null,
      visibility,
    })
    return { success: true, document: { ...document, title: document.filename, sourceType: 'upload', visibility } }
  }

  const note = noteSchema.parse(await request.json())
  const created = await createWorkspaceNote({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    title: note.title,
    content: note.content,
    visibility: note.visibility,
  })
  if (!created) throw new ApiError('Knowledge storage is disabled for this workspace.', 409, 'KNOWLEDGE_DISABLED')
  return {
    success: true,
    document: {
      id: created.id,
      title: note.title,
      filename: `${note.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'note'}.md`,
      mimeType: 'text/markdown',
      sourceType: 'manual',
      visibility: note.visibility,
      chunkCount: created.chunkCount,
    },
  }
}, {
  requires: 'member',
  // Each upload fans out into chunking + embedding generation — throttled so a
  // scripted loop can't turn the embedding pipeline into a cost hole.
  rateLimit: { feature: 'knowledge-upload', perUser: 20 },
  maxBodyBytes: MAX_UPLOAD_BODY_BYTES,
})

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
