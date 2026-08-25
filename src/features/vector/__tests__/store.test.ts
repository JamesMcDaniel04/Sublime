/**
 * Flow vector collections against real pgvector.
 *
 * Tested against a real database because every claim here is about SQL: the
 * `<=>` operator's direction, the ON CONFLICT key, and above all the WHERE
 * clause that keeps one workspace's documents out of another's results. A
 * stub would prove none of it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  /** A deterministic unit vector pointing mostly along one axis. */
  const vectorAt = (axis: number, dim = 1024): number[] => {
    const values = new Array(dim).fill(0.001)
    values[axis % dim] = 1
    return values
  }

  test('vector collections', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { upsertVectorDocuments, searchVectorDocuments, deleteVectorDocuments } = await import('../store')

    const seeded = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    after(async () => {
      await seeded.cleanup()
      await other.cleanup()
      await prisma.$disconnect()
    })

    const org = seeded.organizationId

    await t.test('documents are written and found', async () => {
      const result = await upsertVectorDocuments(org, 'tickets', [
        { externalId: 't1', content: 'printer on fire', embedding: vectorAt(0) },
        { externalId: 't2', content: 'billing question', embedding: vectorAt(500) },
      ])
      assert.equal(result.written, 2)

      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 1 })
      assert.equal(hits.length, 1)
      assert.equal(hits[0].externalId, 't1', 'the nearest document was not returned first')
    })

    // Getting the distance direction backwards returns the LEAST similar
    // results, which still looks like a working search.
    await t.test('results are ordered nearest first', async () => {
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 2 })
      assert.deepEqual(hits.map((hit) => hit.externalId), ['t1', 't2'])
      assert.ok(hits[0].score > hits[1].score, 'scores did not decrease with distance')
    })

    await t.test('an exact match scores near 1', async () => {
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 1 })
      assert.ok(hits[0].score > 0.99, `an identical vector scored ${hits[0].score}`)
    })

    // THE property. A retrieval step that crossed workspaces would feed one
    // customer's documents into another's LLM context, silently.
    await t.test('a search never crosses workspaces', async () => {
      await upsertVectorDocuments(other.organizationId, 'tickets', [
        { externalId: 'secret', content: 'other workspace secret', embedding: vectorAt(0) },
      ])
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 50 })
      assert.ok(
        !hits.some((hit) => hit.externalId === 'secret'),
        'another workspace\'s document appeared in the results',
      )
    })

    await t.test('collections are separate namespaces', async () => {
      await upsertVectorDocuments(org, 'articles', [
        { externalId: 'a1', content: 'an article', embedding: vectorAt(0) },
      ])
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 50 })
      assert.ok(!hits.some((hit) => hit.externalId === 'a1'), 'a document leaked across collections')
    })

    // Re-embedding a source must update rather than accumulate near-duplicates
    // that all match and crowd out everything else.
    await t.test('re-writing a document updates it in place', async () => {
      await upsertVectorDocuments(org, 'tickets', [
        { externalId: 't1', content: 'printer is fine now', embedding: vectorAt(0) },
      ])
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 10 })
      const matches = hits.filter((hit) => hit.externalId === 't1')
      assert.equal(matches.length, 1, 'the document was duplicated instead of updated')
      assert.equal(matches[0].content, 'printer is fine now')
    })

    await t.test('metadata travels with the document', async () => {
      await upsertVectorDocuments(org, 'tickets', [
        { externalId: 't3', content: 'has metadata', embedding: vectorAt(3), metadata: { priority: 'high' } },
      ])
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(3), { limit: 1 })
      assert.deepEqual(hits[0].metadata, { priority: 'high' })
    })

    await t.test('a similarity threshold excludes distant documents', async () => {
      const strict = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 50, minScore: 0.99 })
      assert.ok(strict.every((hit) => hit.score >= 0.99), 'a result below the threshold was returned')
      const loose = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 50, minScore: -1 })
      assert.ok(loose.length > strict.length, 'the threshold had no effect')
    })

    await t.test('the result count is bounded even when asked for more', async () => {
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 10_000 })
      assert.ok(hits.length <= 100, `the limit was not enforced (${hits.length} rows)`)
    })

    // The quiet failure this guards: a mismatched model produces rankings that
    // look plausible and mean nothing.
    await t.test('a wrongly sized embedding is refused rather than stored', async () => {
      await assert.rejects(
        () => upsertVectorDocuments(org, 'tickets', [
          { externalId: 'bad', content: 'wrong dims', embedding: new Array(1536).fill(0.1) },
        ]),
        /1536/,
      )
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(0), { limit: 50 })
      assert.ok(!hits.some((hit) => hit.externalId === 'bad'), 'the bad document was written anyway')
    })

    await t.test('a search with a wrongly sized embedding is refused', async () => {
      await assert.rejects(
        () => searchVectorDocuments(org, 'tickets', new Array(512).fill(0.1)),
        /512/,
      )
    })

    await t.test('an unusable collection name is refused', async () => {
      await assert.rejects(
        () => searchVectorDocuments(org, 'not a valid name!', vectorAt(0)),
        /collection name/i,
      )
    })

    await t.test('documents can be deleted', async () => {
      const { deleted } = await deleteVectorDocuments(org, 'tickets', ['t2'])
      assert.equal(deleted, 1)
      const hits = await searchVectorDocuments(org, 'tickets', vectorAt(500), { limit: 50 })
      assert.ok(!hits.some((hit) => hit.externalId === 't2'))
    })

    await t.test('deleting cannot reach another workspace', async () => {
      const { deleted } = await deleteVectorDocuments(org, 'tickets', ['secret'])
      assert.equal(deleted, 0, 'a delete crossed workspaces')
      const theirs = await searchVectorDocuments(other.organizationId, 'tickets', vectorAt(0), { limit: 10 })
      assert.ok(theirs.some((hit) => hit.externalId === 'secret'), 'the other workspace lost its document')
    })
  })
}
