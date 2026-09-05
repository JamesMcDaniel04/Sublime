import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { readWorkspaceFile, updateWorkspaceFile, viewerKnowledgeScope } from '@/lib/knowledge/files'

export const dynamic = 'force-dynamic'

const MAX_NOTE_CHARS = 200_000

function documentId(request: Request): string {
  const id = new URL(request.url).pathname.split('/').filter(Boolean).at(-1)
  if (!id) throw new ApiError('Document id is required')
  return decodeURIComponent(id)
}

// GET — one document with its decrypted body, for the /knowledge viewer.
// `?download=1` streams the body as a file attachment instead.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const scope = await viewerKnowledgeScope(auth.organizationId, auth.dbUser.id)
  const doc = await readWorkspaceFile(scope, documentId(request))
  if (!doc) throw new ApiError('Knowledge document not found', 404, 'NOT_FOUND')
  if (new URL(request.url).searchParams.get('download') === '1') {
    // Only the extracted text is retained (never the original binary), so a
    // PDF or DOCX downloads as its text; the extension says so.
    const textual = /^text\//.test(doc.mimeType) || /\.(md|markdown|txt|csv|tsv|json|jsonl|ya?ml|xml|html?|log)$/i.test(doc.filename)
    const filename = textual ? doc.filename : `${doc.filename}.txt`
    return new Response(doc.content, {
      headers: {
        'Content-Type': `${textual && doc.mimeType ? doc.mimeType : 'text/plain'}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${filename.replace(/["\r\n]/g, '')}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  }
  const isAdmin = auth.dbUser.role === 'ADMIN'
  return {
    success: true,
    document: {
      id: doc.id,
      title: doc.title,
      filename: doc.filename,
      mimeType: doc.mimeType,
      sourceType: doc.sourceType,
      visibility: doc.visibility,
      sizeBytes: doc.sizeBytes,
      charCount: doc.charCount,
      content: doc.content,
      canEdit: doc.editable && (doc.userId === auth.dbUser.id || (isAdmin && doc.visibility === 'organization')),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    },
  }
}, { requires: 'member' })

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().min(1).max(MAX_NOTE_CHARS).optional(),
    visibility: z.enum(['organization', 'private']).optional(),
  })
  .refine((body) => body.title !== undefined || body.content !== undefined || body.visibility !== undefined, {
    message: 'Provide a title, content, or visibility to change',
  })

// PUT — edit a repository file in place (title, Markdown body, visibility).
// The id survives so agent references and links keep working; the body is
// re-chunked and re-embedded. Auto-captured knowledge is not editable.
export const PUT = withAuthenticatedApi(async (request, auth) => {
  const id = documentId(request)
  const body = updateSchema.parse(await request.json())
  const doc = await prisma.knowledgeDocument.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, userId: true, visibility: true },
  })
  if (!doc) throw new ApiError('Knowledge document not found', 404, 'NOT_FOUND')
  const canEdit = doc.userId === auth.dbUser.id || (auth.dbUser.role === 'ADMIN' && doc.visibility === 'organization')
  if (!canEdit) throw new ApiError('You cannot edit this knowledge document', 403, 'FORBIDDEN')
  const result = await updateWorkspaceFile({ organizationId: auth.organizationId, id, ...body })
  if (!result.ok) {
    if (result.reason === 'not-found') throw new ApiError('Knowledge document not found', 404, 'NOT_FOUND')
    if (result.reason === 'not-editable') throw new ApiError('Only uploaded files and notes can be edited.', 409, 'NOT_EDITABLE')
    if (result.reason === 'empty') throw new ApiError('A file cannot be saved empty.', 400, 'EMPTY')
    throw new ApiError('Knowledge storage is disabled for this workspace.', 409, 'KNOWLEDGE_DISABLED')
  }
  return { success: true }
}, {
  requires: 'member',
  // An edit re-embeds the whole body — same budget as an upload.
  rateLimit: { feature: 'knowledge-upload', perUser: 20 },
})
