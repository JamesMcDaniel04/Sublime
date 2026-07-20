/**
 * recomputeOrgPersona against a real Postgres (TEST_DATABASE_URL): weights
 * persisted from real connection rows, cooldown debounce, and narrative
 * degradation/retention. Skipped without TEST_DATABASE_URL (mirrors
 * route-smoke / tool-capture-e2e).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let organizationId: string
  let recomputeOrgPersona: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    organizationId = seeded.organizationId
    ;({ recomputeOrgPersona } = await import('../compute'))
    // A connected GitHub mirror row is the base signal for every case below.
    await prisma.nangoConnection.create({
      data: {
        organizationId, userId: seeded.userId, connectionId: 'conn-gh-1',
        providerConfigKey: 'github-app', provider: 'github', status: 'connected',
      },
    })
  })
  after(async () => { if (seeded) await seeded.cleanup() })

  test('computes and persists deterministic weights; no narrative without usage signal', async () => {
    const result = await recomputeOrgPersona(organizationId)
    assert.equal(result.status, 'computed')
    const row = await prisma.organizationPersona.findUnique({ where: { organizationId } })
    assert.ok(row)
    assert.ok((row.departmentWeights as Record<string, number>).engineering > 0)
    assert.equal(row.narrative, null)
    assert.equal(row.confidence, null)
  })

  test('cooldown: an immediate second call skips; force bypasses', async () => {
    assert.equal((await recomputeOrgPersona(organizationId)).status, 'skipped-cooldown')
    assert.equal((await recomputeOrgPersona(organizationId, { force: true })).status, 'computed')
  })

  test('activity signal unlocks narrative; generator failure degrades and never regresses a stored narrative', async () => {
    await prisma.activityEvent.create({
      data: {
        organizationId, source: 'github', actorRef: 'dev1', action: 'opened_pr',
        entityType: 'pull_request', entityRef: 'acme/app#1', occurredAt: new Date(),
        ingestKind: 'backfill', dedupeKey: 'github:acme/app:pr:1',
      },
    })
    const failing = async () => { throw new Error('llm down') }
    assert.equal((await recomputeOrgPersona(organizationId, { force: true }, { generate: failing })).status, 'computed')
    let row = await prisma.organizationPersona.findUnique({ where: { organizationId } })
    assert.equal(row.narrative, null) // weights written; narrative degraded

    const generate = async () => JSON.stringify({ narrative: 'An engineering-led team shipping via GitHub.', confidence: 0.8 })
    await recomputeOrgPersona(organizationId, { force: true }, { generate })
    row = await prisma.organizationPersona.findUnique({ where: { organizationId } })
    assert.equal(row.narrative, 'An engineering-led team shipping via GitHub.')
    assert.equal(row.confidence, 0.8)

    // A later failing pass keeps (never nulls) the stored narrative.
    await recomputeOrgPersona(organizationId, { force: true }, { generate: failing })
    row = await prisma.organizationPersona.findUnique({ where: { organizationId } })
    assert.equal(row.narrative, 'An engineering-led team shipping via GitHub.')
  })
} else {
  test('persona compute (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
