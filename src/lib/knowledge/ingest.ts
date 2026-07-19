import { extractText, isSupported } from './extract'
import { storeKnowledge } from './store'

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
      'Unsupported file type. Upload PDF, DOCX, text, markdown, CSV, JSON, HTML, or source files.',
    )
  }
  const raw = await extractText(params.buffer, params.mimeType, params.filename)
  if (!raw) throw new UnsupportedFileError('No readable text was found in that file.')
  const stored = await storeKnowledge({
    organizationId: params.organizationId,
    agentId: params.agentId,
    userId: params.userId,
    sourceType: 'upload',
    title: params.filename,
    filename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.buffer.length,
    content: raw,
    visibility: params.agentId ? 'agent' : 'organization',
    provenance: { kind: 'upload', originalFilename: params.filename },
  })
  if (!stored.stored || !stored.id) throw new UnsupportedFileError('Knowledge storage is disabled for this workspace.')
  return {
    id: stored.id,
    filename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.buffer.length,
    charCount: raw.slice(0, 200_000).length,
    chunkCount: stored.chunkCount ?? 0,
    createdAt: stored.createdAt ?? new Date(),
  }
}
