/**
 * Text extraction + chunking for uploaded knowledge files: text-based formats
 * (plain text, markdown, csv/tsv, json, yaml, xml, html, common source code)
 * plus PDF (pdf-parse) and DOCX (mammoth). Parsers load lazily so the bundle
 * only pays for them on an actual PDF/DOCX upload.
 */

import { assertDeclaredKindMatches, assertZipWithinBudget } from '@/lib/security/file-signature'

// A DOCX is a zip. 64 MB of expanded XML is far beyond any real document and
// far below what a decompression bomb aims for, so it separates the two
// cleanly. Checked from the archive index — nothing is decompressed to find out.
const MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024

const CODE_EXT =
  /\.(md|markdown|txt|text|csv|tsv|json|jsonl|ya?ml|xml|html?|log|js|ts|tsx|jsx|py|rb|go|java|kt|c|cc|cpp|h|hpp|cs|php|rs|swift|sh|bash|sql|css|scss|less|toml|ini|env)$/i

/** Whether a file can be extracted to text in v1. */
export function isSupported(mimeType: string, filename: string): boolean {
  if (/^text\//i.test(mimeType)) return true
  if (/^application\/(json|xml|csv|markdown|x-yaml|yaml|xhtml\+xml|javascript|sql)/i.test(mimeType)) return true
  if (isPdf(mimeType, filename) || isDocx(mimeType, filename)) return true
  return CODE_EXT.test(filename)
}

function isPdf(mimeType: string, filename: string): boolean {
  return /^application\/pdf$/i.test(mimeType) || /\.pdf$/i.test(filename)
}

function isDocx(mimeType: string, filename: string): boolean {
  return (
    /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i.test(mimeType) ||
    /\.docx$/i.test(filename)
  )
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

const NULL_CHAR = String.fromCharCode(0)

function normalize(text: string): string {
  return text.split(NULL_CHAR).join('').replace(/\r\n/g, '\n').trim()
}

/**
 * Decode a file's bytes to normalized text. PDF/DOCX route through their
 * parsers (lazy-imported); HTML is stripped to visible text; everything else
 * is decoded as UTF-8.
 */
export async function extractText(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  // isSupported() is a cheap pre-check on the CLIENT'S CLAIM — it accepts a
  // file when the MIME type or the extension matches, so the claim alone can
  // route arbitrary bytes into pdf-parse or mammoth. This is where the bytes
  // themselves get the final word, before any parser sees them.
  assertDeclaredKindMatches(buffer, mimeType, filename)

  if (isPdf(mimeType, filename)) {
    const pdfParse = (await import('pdf-parse')).default
    const parsed = await pdfParse(buffer)
    return normalize(parsed.text || '')
  }
  if (isDocx(mimeType, filename)) {
    assertZipWithinBudget(buffer, MAX_DOCX_UNCOMPRESSED_BYTES)
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer })
    return normalize(result.value || '')
  }
  let text = buffer.toString('utf-8')
  if (/html/i.test(mimeType) || /\.html?$/i.test(filename)) text = stripHtml(text)
  return normalize(text)
}

/**
 * Split text into overlapping chunks, preferring paragraph/sentence boundaries
 * within each window so a chunk doesn't cut mid-thought.
 */
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): string[] {
  const size = opts.size ?? 1200
  const overlap = opts.overlap ?? 150
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= size) return [clean]

  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length)
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '))
      if (boundary > size * 0.5) end = start + boundary + 1
    }
    const piece = clean.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}
