import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertDeclaredKindMatches,
  assertZipWithinBudget,
  FileSignatureError,
  sniffFileKind,
} from '../file-signature'

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< >>\nendobj\n')
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])

test('detects a PDF by its header', () => {
  assert.equal(sniffFileKind(PDF), 'pdf')
})

test('detects a zip container (DOCX is a zip) by its header', () => {
  assert.equal(sniffFileKind(ZIP), 'zip')
})

test('detects UTF-8 text', () => {
  assert.equal(sniffFileKind(Buffer.from('# Notes\n\nhello — ünïcode\n')), 'text')
})

test('binary noise is neither text nor a known container', () => {
  assert.equal(sniffFileKind(Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02])), 'unknown')
})

test('rejects bytes that contradict a .pdf name', () => {
  // The exact hole the OR-allowlist left open: isSupported() accepted a file
  // when the MIME type OR the extension matched, so any bytes named .pdf went
  // straight to pdf-parse (last published 2018).
  assert.throws(() => assertDeclaredKindMatches(ZIP, 'application/pdf', 'evil.pdf'), FileSignatureError)
})

test('rejects a PDF masquerading as a DOCX', () => {
  assert.throws(
    () =>
      assertDeclaredKindMatches(
        PDF,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'evil.docx',
      ),
    FileSignatureError,
  )
})

test('rejects binary bytes declared as text', () => {
  assert.throws(
    () => assertDeclaredKindMatches(Buffer.from([0x00, 0xff, 0xfe]), 'text/plain', 'notes.txt'),
    FileSignatureError,
  )
})

test('accepts a genuine PDF, DOCX and text file', () => {
  assert.doesNotThrow(() => assertDeclaredKindMatches(PDF, 'application/pdf', 'report.pdf'))
  assert.doesNotThrow(() =>
    assertDeclaredKindMatches(
      ZIP,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'report.docx',
    ),
  )
  assert.doesNotThrow(() => assertDeclaredKindMatches(Buffer.from('# hello'), 'text/markdown', 'notes.md'))
})

test('an empty file is refused rather than guessed at', () => {
  assert.throws(() => assertDeclaredKindMatches(Buffer.alloc(0), 'text/plain', 'empty.txt'), FileSignatureError)
})

// ── Decompression bombs ────────────────────────────────────────────────────

/** Build a minimal zip whose central directory declares `uncompressed` bytes. */
function zipDeclaring(uncompressed: number): Buffer {
  const name = Buffer.from('word/document.xml')
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0) // central directory header
  central.writeUInt32LE(1, 20) // compressed size
  central.writeUInt32LE(uncompressed, 24) // UNCOMPRESSED size — the lie a bomb tells
  central.writeUInt16LE(name.length, 28)
  name.copy(central, 46)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory
  eocd.writeUInt16LE(1, 8) // entries on this disk
  eocd.writeUInt16LE(1, 10) // total entries
  eocd.writeUInt32LE(central.length, 12) // central directory size
  eocd.writeUInt32LE(4, 16) // central directory offset

  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), central, eocd])
}

test('a zip declaring gigabytes of output is refused before parsing', () => {
  // 4 GB, the largest a classic (non-ZIP64) central directory can express.
  assert.throws(() => assertZipWithinBudget(zipDeclaring(4_000_000_000), 64 * 1024 * 1024), FileSignatureError)
})

test('a ZIP64 sentinel size is refused rather than read as a small number', () => {
  // ZIP64 stores 0xFFFFFFFF in the 32-bit field and the real size in an extra
  // record. Reading the sentinel literally yields ~4.29 GB, which fails the
  // budget — the safe direction, and worth pinning so a future "handle ZIP64
  // properly" change cannot quietly turn it into a bypass.
  assert.throws(() => assertZipWithinBudget(zipDeclaring(0xffffffff), 64 * 1024 * 1024), FileSignatureError)
})

test('an ordinary document passes the budget', () => {
  assert.doesNotThrow(() => assertZipWithinBudget(zipDeclaring(50_000), 64 * 1024 * 1024))
})

test('a zip with no readable central directory is refused, not assumed safe', () => {
  assert.throws(() => assertZipWithinBudget(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 64 * 1024 * 1024), FileSignatureError)
})
