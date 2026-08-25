/**
 * Node migration through the real route.
 *
 * Lives here rather than beside the route because node:test reads its path
 * arguments as globs, and `[id]` is a character class — a test under a
 * bracketed directory is silently never collected.
 *
 * The property that matters is the one that keeps this safe to offer at all:
 * migrating touches the DRAFT and never the published graph. `publishedGraph`
 * is what scheduled and triggered runs execute, so rewriting it here would
 * change production behaviour with nobody reviewing the change.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const req = (id: string, method = 'GET') =>
    new NextRequest(new URL(`http://test/api/flows/${id}/migrate`), { method } as never)

  const legacyGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'check', type: 'condition', data: { left: '{{trigger.input}}', op: 'eq', right: 'go' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'check' }],
  }

  test('flow node migration', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { GET, POST } = await import('../[id]/migrate/route')

    const seeded = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    after(async () => {
      clearTestAuth()
      await seeded.cleanup()
      await other.cleanup()
      await prisma.$disconnect()
    })

    const flow = await prisma.flow.create({
      data: {
        name: 'Legacy condition',
        organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id,
        graph: legacyGraph,
        publishedGraph: legacyGraph,
        status: 'ACTIVE',
      },
      select: { id: true },
    })

    await t.test('an outdated node is reported', async () => {
      const body = await (await GET(req(flow.id))).json()
      assert.equal(body.outdated.length, 1)
      assert.equal(body.outdated[0].id, 'check')
      assert.equal(body.outdated[0].from, 1)
      assert.equal(body.outdated[0].to, 2)
    })

    await t.test('what is RUNNING is reported separately', async () => {
      const body = await (await GET(req(flow.id))).json()
      assert.equal(body.publishedOutdated.length, 1, 'the published graph was not reported')
    })

    await t.test('migrating rewrites the draft', async () => {
      const body = await (await POST(req(flow.id, 'POST'))).json()
      assert.equal(body.migrated.length, 1)

      const after = await prisma.flow.findFirstOrThrow({
        where: { id: flow.id, organizationId: seeded.auth.organizationId },
        select: { graph: true },
      })
      const node = (after.graph as { nodes: { id: string; typeVersion?: number; data: Record<string, unknown> }[] })
        .nodes.find((n) => n.id === 'check')
      assert.equal(node?.typeVersion, 2)
      assert.deepEqual(node?.data.clauses, [{ left: '{{trigger.input}}', op: 'eq', right: 'go' }])
      assert.equal('left' in (node?.data ?? {}), false, 'the legacy fields survived the migration')
    })

    // The load-bearing property.
    await t.test('the published graph is left exactly as it was', async () => {
      const after = await prisma.flow.findFirstOrThrow({
        where: { id: flow.id, organizationId: seeded.auth.organizationId },
        select: { publishedGraph: true },
      })
      assert.deepEqual(
        after.publishedGraph,
        legacyGraph,
        'migrating rewrote what production runs',
      )
    })

    await t.test('migrating twice changes nothing further', async () => {
      const body = await (await POST(req(flow.id, 'POST'))).json()
      assert.equal(body.migrated.length, 0)
    })

    await t.test('another workspace cannot read or migrate the flow', async () => {
      installTestAuth(other.auth)
      assert.equal((await GET(req(flow.id))).status, 404)
      assert.equal((await POST(req(flow.id, 'POST'))).status, 404)
      installTestAuth(seeded.auth)
    })

    await t.test('the migration is audited', async () => {
      const events = await prisma.auditEvent.findMany({
        where: { organizationId: seeded.auth.organizationId, action: 'flow.nodes.migrated' },
      })
      assert.ok(events.length >= 1)
    })
  })
} else {
  test('flow node migration (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
