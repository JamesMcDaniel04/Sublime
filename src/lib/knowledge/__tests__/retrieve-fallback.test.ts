/**
 * DB-gated tests for the keyword-fallback retrieval path (no embeddings
 * configured): encrypted chunks must decrypt and rank by term overlap, and
 * rows that decrypt to nothing (corrupt payload with no legacy plaintext)
 * must be dropped instead of surfacing as blank "knowledge".
 * Self-skips (0 tests reported) when TEST_DATABASE_URL isn't set.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY
  process.env.ENCRYPTION_KEY = 'retrieve-fallback-test-key'

  let prisma: any
  let retrieveKnowledge: any
  let encryptSecret: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ retrieveKnowledge } = await import('../retrieve'))
    ;({ encryptSecret } = await import('@/lib/crypto/secrets'))
    const org = await prisma.organization.create({ data: { name: 'Fallback Org', slug: `fallback-${crypto.randomUUID()}` } })
    ids.org = org.id
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: ids.org,
        filename: 'fallback.md',
        mimeType: 'text/markdown',
        sourceType: 'upload',
        sourceId: `fallback-${crypto.randomUUID()}`,
        visibility: 'organization',
      },
    })
    ids.doc = doc.id
    await prisma.knowledgeChunk.create({
      data: {
        documentId: ids.doc, organizationId: ids.org, ordinal: 0, content: '',
        contentEncrypted: encryptSecret('the enterprise pricing playbook lives in Notion'),
      },
    })
    // Corrupt payload, no legacy plaintext: decrypts to '' and must be dropped.
    await prisma.knowledgeChunk.create({
      data: {
        documentId: ids.doc, organizationId: ids.org, ordinal: 1, content: '',
        contentEncrypted: 'v1:not:really:valid',
      },
    })
  })

  after(async () => {
    delete process.env.ENCRYPTION_KEY
    await prisma.knowledgeChunk.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.knowledgeDocument.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('keyword fallback decrypts, ranks by overlap, and drops undecryptable rows', async () => {
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: 'no-such-agent',
      query: 'enterprise pricing playbook',
      k: 5,
    })
    assert.equal(hits.length, 1, 'corrupt empty-content row must not surface')
    assert.ok(hits[0].content.includes('enterprise pricing playbook'))
    assert.ok(hits[0].score > 0)
  })

  test('keyword fallback returns nothing for a non-matching query', async () => {
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: 'no-such-agent',
      query: 'completely unrelated zebra migration',
      k: 5,
    })
    assert.equal(hits.length, 0)
  })
}
