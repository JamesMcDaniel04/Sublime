/**
 * Content-based file type verification for uploads.
 *
 * The allowlist this replaces (`isSupported` in src/lib/knowledge/extract.ts)
 * accepted a file when the declared MIME type OR the filename extension
 * matched — either alone was enough, and neither was checked against the bytes.
 * Anything named `.pdf` therefore reached `pdf-parse` (last published 2018) and
 * anything named `.docx` reached `mammoth`, both in-process, both parsing
 * attacker-chosen bytes.
 *
 * These helpers close that by requiring the declaration and the content to
 * agree, and by bounding what a zip container claims it will expand to before
 * anything unzips it.
 */

export class FileSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileSignatureError'
  }
}

export type FileKind = 'pdf' | 'zip' | 'text' | 'unknown'

const PDF_MAGIC = Buffer.from('%PDF-')
// Local file header. An empty (0x05 0x06) or spanned (0x07 0x08) archive is not
// a document we can extract, so only the standard header counts as a DOCX.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const TEXT_SNIFF_BYTES = 8192

/**
 * Classify a buffer by its leading bytes.
 *
 * `text` means "decodes as UTF-8 with no NUL bytes in the first 8 KB" — the
 * property that matters downstream, since every non-PDF, non-DOCX branch of
 * extractText() calls buffer.toString('utf-8').
 */
export function sniffFileKind(buffer: Buffer): FileKind {
  if (buffer.length === 0) return 'unknown'
  if (buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return 'pdf'
  if (buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) return 'zip'

  const head = buffer.subarray(0, TEXT_SNIFF_BYTES)
  if (head.includes(0x00)) return 'unknown'
  // TextDecoder in fatal mode is the cheapest correct UTF-8 validity check.
  // Decoding a truncated multi-byte sequence at the 8 KB boundary would be a
  // false negative, so trim back to the last plausible sequence start.
  const safeEnd = trimToCharBoundary(head)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, safeEnd))
    return 'text'
  } catch {
    return 'unknown'
  }
}

/** Walk back off a partial multi-byte sequence at the end of a sniff window. */
function trimToCharBoundary(head: Buffer): number {
  if (head.length < TEXT_SNIFF_BYTES) return head.length
  let end = head.length
  // A continuation byte is 10xxxxxx; step back past up to 3 of them plus the
  // lead byte, which covers every valid UTF-8 sequence length.
  for (let i = 0; i < 4 && end > 0; i += 1) {
    const byte = head[end - 1]
    end -= 1
    if ((byte & 0xc0) !== 0x80) break
  }
  return end
}

function declaredKind(mimeType: string, filename: string): FileKind {
  if (/^application\/pdf$/i.test(mimeType) || /\.pdf$/i.test(filename)) return 'pdf'
  if (
    /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i.test(mimeType) ||
    /\.docx$/i.test(filename)
  ) {
    return 'zip'
  }
  return 'text'
}

/**
 * Throw unless the bytes match what the upload claims to be.
 *
 * The declaration comes from the client (`file.type` and `file.name`), so it is
 * a hint, never evidence. This is the function that turns it into a constraint.
 */
export function assertDeclaredKindMatches(buffer: Buffer, mimeType: string, filename: string): void {
  if (buffer.length === 0) throw new FileSignatureError('That file is empty.')

  const expected = declaredKind(mimeType, filename)
  const actual = sniffFileKind(buffer)
  if (actual === expected) return

  const label = expected === 'zip' ? 'a Word document' : expected === 'pdf' ? 'a PDF' : 'text'
  throw new FileSignatureError(
    `This file does not look like ${label} — its contents do not match its type. `
      + 'Re-save it in the expected format and try again.',
  )
}

// ── Decompression bombs ────────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_MIN_LENGTH = 22
// The EOCD sits at the end, after an optional comment of up to 64 KB.
const EOCD_SEARCH_WINDOW = 65_536 + EOCD_MIN_LENGTH

/**
 * Throw when a zip's central directory declares more expanded output than the
 * budget allows.
 *
 * Reads only the DECLARED sizes, which costs no decompression. A bomb that lies
 * about its sizes to get past this then fails inside the real parser on bytes
 * that do not match their header — so the cheap check is the right one to make
 * first, not the only one that has to hold.
 */
export function assertZipWithinBudget(buffer: Buffer, maxUncompressedBytes: number): void {
  const eocd = findEocdOffset(buffer)
  if (eocd === -1) {
    throw new FileSignatureError('This file is not a readable Word document — its archive index is missing.')
  }

  const entries = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  let total = 0

  for (let i = 0; i < entries; i += 1) {
    if (offset + 46 > buffer.length) {
      throw new FileSignatureError('This file is not a readable Word document — its archive index is truncated.')
    }
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new FileSignatureError('This file is not a readable Word document — its archive index is corrupt.')
    }

    total += buffer.readUInt32LE(offset + 24)
    if (total > maxUncompressedBytes) {
      throw new FileSignatureError('This document expands to more content than we can process.')
    }

    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    offset += 46 + nameLength + extraLength + commentLength
  }
}

function findEocdOffset(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW)
  for (let i = buffer.length - EOCD_MIN_LENGTH; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return -1
}
