import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSupported, extractText, chunkText } from '../extract'

test('isSupported accepts text formats and rejects binaries', () => {
  assert.equal(isSupported('text/plain', 'notes.txt'), true)
  assert.equal(isSupported('application/json', 'data.json'), true)
  assert.equal(isSupported('', 'README.md'), true)
  assert.equal(isSupported('image/png', 'logo.png'), false)
})

test('extractText decodes text and strips HTML markup', async () => {
  assert.equal(await extractText(Buffer.from('Hello\r\nworld'), 'text/plain', 'a.txt'), 'Hello\nworld')
  const html = await extractText(Buffer.from('<p>Hi <b>there</b></p><script>bad()</script>'), 'text/html', 'a.html')
  assert.equal(html.replace(/\s+/g, ' ').trim(), 'Hi there')
})

test('isSupported accepts PDF and DOCX by mime and extension', () => {
  assert.equal(isSupported('application/pdf', 'deck.pdf'), true)
  assert.equal(isSupported('application/octet-stream', 'contract.PDF'), true)
  assert.equal(isSupported('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'notes.docx'), true)
  assert.equal(isSupported('application/octet-stream', 'notes.docx'), true)
})

test('chunkText returns one chunk for short text, many for long', () => {
  assert.deepEqual(chunkText('short'), ['short'])
  assert.deepEqual(chunkText(''), [])
  const long = 'para. '.repeat(600) // ~3600 chars
  const chunks = chunkText(long, { size: 1200, overlap: 150 })
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every((c) => c.length <= 1200))
})

test('extractText refuses bytes that contradict the declared type', async () => {
  // The OR-allowlist let anything named .pdf reach pdf-parse. isSupported()
  // still says yes here (the name matches); extractText is where the bytes get
  // the final word.
  const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)])
  assert.equal(isSupported('application/pdf', 'evil.pdf'), true)
  await assert.rejects(() => extractText(zipBytes, 'application/pdf', 'evil.pdf'), /does not look like a PDF/)
})

test('extractText refuses binary bytes declared as plain text', async () => {
  await assert.rejects(
    () => extractText(Buffer.from([0x00, 0xff, 0xfe, 0x03]), 'text/plain', 'notes.txt'),
    /does not look like text/,
  )
})

test('extractText refuses an empty upload', async () => {
  await assert.rejects(() => extractText(Buffer.alloc(0), 'text/plain', 'empty.txt'), /empty/)
})
