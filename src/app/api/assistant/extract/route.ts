import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { extractText, isSupported } from '@/lib/knowledge/extract'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'

// Max upload size (pre-extraction) — matches the knowledge upload route.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB
// Extracted text cap: enough for a long assignment brief without letting one
// document dominate the assistant's prompt budget.
const MAX_TEXT_CHARS = 24_000

/**
 * Turns an uploaded assignment file into plain text for the Home assistant.
 * Nothing is persisted here — the client sends the text back with its next
 * chat message, where it is stored as message metadata.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`assistant-extract:${auth.dbUser.id}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Rate limit exceeded', 429, 'RATE_LIMITED')

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) throw new ApiError('Attach a file in the "file" field.')
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError('File is too large (max 10 MB).', 413, 'TOO_LARGE')

  const filename = file.name || 'upload'
  const mimeType = file.type || 'application/octet-stream'
  if (!isSupported(mimeType, filename)) {
    throw new ApiError('This file type is not supported — use text, markdown, PDF, or DOCX.', 415, 'UNSUPPORTED_TYPE')
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  let text: string
  try {
    text = await extractText(buffer, mimeType, filename)
  } catch (error) {
    throw new ApiError('Could not read this file — it may be corrupted.', 422, 'EXTRACTION_FAILED', error)
  }
  if (!text) throw new ApiError('No text found in this file.', 422, 'EMPTY_FILE')

  const truncated = text.length > MAX_TEXT_CHARS
  return { success: true, filename, text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated }
}, { requires: 'member' })
