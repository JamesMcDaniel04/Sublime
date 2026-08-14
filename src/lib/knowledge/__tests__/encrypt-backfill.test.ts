/**
 * DB-gated tests for the nightly encryption backfill: legacy plaintext chunk
 * rows must converge onto AES-256-GCM (plaintext blanked), b64 fallback rows
 * must be upgraded, and the sweep must self-skip without a real key.
 * Self-skips (0 tests reported) when TEST_DATABASE_URL isn't set.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let encryptLegacyKnowledge: any
  let decryptSecret: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ encryptLegacyKnowledge } = await import('../encrypt-backfill'))
    ;({ decryptSecret } = await import('@/lib/crypto/secrets'))
    const org = await prisma.organization.create({ data: { name: 'Backfill Org', slug: `backfill-${crypto.randomUUID()}` } })
    ids.org = org.id
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: ids.org,
        filename: 'legacy.md',
        mimeType: 'text/markdown',
        sourceType: 'upload',
        sourceId: `backfill-${crypto.randomUUID()}`,
      },
    })
    ids.doc = doc.id
  })

  after(async () => {
    delete process.env.ENCRYPTION_KEY
    await prisma.knowledgeChunk.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.knowledgeDocument.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('self-skips when no real ENCRYPTION_KEY is configured', async () => {
    delete process.env.ENCRYPTION_KEY
    const result = await encryptLegacyKnowledge()
    assert.deepEqual(result, { skipped: 'encryption-not-configured' })
  })

  test('encrypts legacy plaintext rows and upgrades b64 rows to AES-256-GCM', async () => {
    process.env.ENCRYPTION_KEY = 'backfill-test-key'
    const plaintextRow = await prisma.knowledgeChunk.create({
      data: { documentId: ids.doc, organizationId: ids.org, ordinal: 0, content: 'legacy plaintext body' },
    })
    const b64Row = await prisma.knowledgeChunk.create({
      data: {
        documentId: ids.doc,
        organizationId: ids.org,
        ordinal: 1,
        content: '',
        contentEncrypted: 'b64:' + Buffer.from('b64 fallback body', 'utf8').toString('base64'),
      },
    })
    const untouched = await prisma.knowledgeChunk.create({
      data: { documentId: ids.doc, organizationId: ids.org, ordinal: 2, content: '', contentEncrypted: null },
    })

    const result = await encryptLegacyKnowledge()
    assert.ok('encrypted' in result, `expected a sweep result, got ${JSON.stringify(result)}`)
    assert.ok(result.encrypted >= 1)
    assert.ok(result.upgraded >= 1)

    const after1 = await prisma.knowledgeChunk.findFirst({ where: { id: plaintextRow.id, organizationId: ids.org } })
    assert.equal(after1.content, '', 'plaintext must be blanked')
    // v2 is the current envelope; v1 rows written before the HKDF upgrade are
    // still valid AES-256-GCM, so accept either rather than pinning the version.
    assert.match(after1.contentEncrypted ?? '', /^v[12]:/, 'must be real AES-256-GCM')
    assert.equal(decryptSecret(after1.contentEncrypted), 'legacy plaintext body')

    const after2 = await prisma.knowledgeChunk.findFirst({ where: { id: b64Row.id, organizationId: ids.org } })
    assert.match(after2.contentEncrypted ?? '', /^v[12]:/, 'b64 must upgrade to AES-256-GCM')
    assert.equal(decryptSecret(after2.contentEncrypted), 'b64 fallback body')

    // An empty-content, never-encrypted row has nothing to converge — left alone.
    const after3 = await prisma.knowledgeChunk.findFirst({ where: { id: untouched.id, organizationId: ids.org } })
    assert.equal(after3.contentEncrypted, null)
  })
}
