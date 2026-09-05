/**
 * One upload path for every knowledge surface (per-agent panel, workspace
 * repository): size cap, malware scan, signature check, extraction, and the
 * mapping of each failure to the status a client can act on. Extracted so a
 * second upload route cannot drift from the first on any of those steps.
 */
import { ApiError } from '@/lib/server/api-handler'
import { MalwareDetectedError, scanUpload } from '@/lib/security/scan-upload'
import { recordSecurityEvent } from '@/lib/security/alerts'
import { FileSignatureError } from '@/lib/security/file-signature'
import { ingestKnowledgeFile, UnsupportedFileError } from './ingest'
import type { KnowledgeVisibility } from './store'

// Max upload size for a knowledge file (pre-extraction).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB
// Matches MAX_UPLOAD_BYTES with multipart headroom.
export const MAX_UPLOAD_BODY_BYTES = 12 * 1024 * 1024

export async function ingestUploadedFile(
  file: File,
  target: { organizationId: string; userId: string; agentId: string | null; visibility?: KnowledgeVisibility },
) {
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
        source: target.userId,
        organizationId: target.organizationId,
        detail: { verdict: error.message },
      })
      throw new ApiError(error.message, 422, 'MALWARE_DETECTED', error)
    }
    throw error
  }

  try {
    return await ingestKnowledgeFile({
      organizationId: target.organizationId,
      agentId: target.agentId,
      userId: target.userId,
      filename: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
      buffer,
      visibility: target.visibility,
    })
  } catch (error) {
    if (error instanceof UnsupportedFileError) throw new ApiError(error.message, 415, 'UNSUPPORTED_TYPE')
    // Bytes that contradict the declared type: a rejected upload, not a
    // corrupt one. Distinguishing them tells a user who picked the wrong file
    // something they can act on.
    if (error instanceof FileSignatureError) throw new ApiError(error.message, 415, 'UNSUPPORTED_TYPE', error)
    throw error
  }
}
