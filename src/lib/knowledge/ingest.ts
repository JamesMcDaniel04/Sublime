import { prisma } from '@/lib/prisma'
import { embedTexts, embeddingsConfigured } from '@/lib/rag/embeddings'
import { extractText, chunkText, isSupported } from './extract'

// Bound the work per upload: cap extracted text and chunk count so one huge file
// can't dominate storage or the embeddings bill.
const MAX_CHARS = 200_000
const MAX_CHUNKS = 200

export class UnsupportedFileError extends Error {}

/**
 * Ingest an uploaded file as agent knowledge: extract text, chunk it, embed the
 * chunks (when embeddings are configured), and persist the document + chunks.
 * Only the extracted text is stored — never the original binary.
 */
export async function ingestKnowledgeFile(params: {
  organizationId: string
  agentId: string | null
  userId: string | null
  filename: string
  mimeType: string
  buffer: Buffer
}) {
  if (!isSupported(params.mimeType, params.filename)) {
    throw new UnsupportedFileError(
      'Unsupported file type. Upload text, markdown, CSV, JSON, HTML, or source files (PDF/DOCX support is coming).',
    )
  }
  const raw = extractText(params.buffer, params.mimeType, params.filename)
  if (!raw) throw new UnsupportedFileError('No readable text was found in that file.')
  const text = raw.slice(0, MAX_CHARS)
  const chunks = chunkText(text).slice(0, MAX_CHUNKS)

  const doc = await prisma.knowledgeDocument.create({
    data: {
      organizationId: params.organizationId,
      agentId: params.agentId,
      userId: params.userId,
      filename: params.filename,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      charCount: text.length,
      status: 'ready',
    },
  })

  // Embed the chunks up front so retrieval is fast; degrade to keyword search
  // (no embedding stored) when embeddings aren't configured or the call fails.
  let embeddings: number[][] | null = null
  if (embeddingsConfigured() && chunks.length) {
    try {
      embeddings = await embedTexts(chunks, { inputType: 'document' })
    } catch {
      embeddings = null
    }
  }

  if (chunks.length) {
    await prisma.knowledgeChunk.createMany({
      data: chunks.map((content, i) => ({
        documentId: doc.id,
        organizationId: params.organizationId,
        agentId: params.agentId,
        ordinal: i,
        content,
        embedding: embeddings ? embeddings[i] : undefined,
      })),
    })
  }
  return { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, charCount: doc.charCount, chunkCount: chunks.length, createdAt: doc.createdAt }
}
