/**
 * End-to-end QA drive for the capture-hardening work, following the
 * route-smoke protocol: real Postgres (TEST_DATABASE_URL), seeded auth
 * context, REAL route handlers driven with NextRequest objects.
 *
 * Drives the three things unit tests cannot prove on their own:
 *   1. The negative-signal seams — DELETE /api/goals/[id] and DELETE
 *      /api/mcp-connections must write goal_abandoned / connection_removed
 *      ledger rows through the real handlers and the real tenant guard.
 *   2. The adoption sweep against real Postgres, including the k-anonymity
 *      floor and the maintenance delete that removes a row which stops
 *      qualifying.
 *   3. That the request-path loader reads the aggregate rather than the
 *      un-floored ledger — a below-floor template must be invisible to it.
 *
 * Skipped entirely unless TEST_DATABASE_URL is set (mirrors route-smoke).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seeded: any
  let organizationId: string
  let userId: string

  const req = (path: string, init?: RequestInit) =>
    new NextRequest(new URL(`http://test${path}`), init as never)
  const findEvent = (kind: string, resourceId?: string | null) =>
    prisma.userEvent.findFirst({
      where: {
        organizationId,
        userId,
        kind,
        ...(resourceId !== undefined ? { resourceId } : {}),
      },
    })

  /** A template_used ledger row attributed to an arbitrary org. */
  const seedDeploy = (orgId: string, seedKey: string, resourceId: string) =>
    prisma.userEvent.create({
      data: {
        organizationId: orgId,
        userId,
        kind: 'template_used',
        resourceType: 'flow',
        resourceId,
        context: { seedKey },
      },
    })

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
  })

  after(async () => {
    await systemPrisma?.templateAdoption.deleteMany({}).catch(() => {})
    if (seeded) await seeded.cleanup()
  })

  test('negative signal: archiving a goal writes goal_abandoned', async () => {
    const { id: goalId } = await prisma.goal.create({
      data: {
        organizationId,
        name: 'QA Abandoned Goal',
        kind: 'arr',
        direction: 'increase',
        unit: 'usd',
        startValue: 0,
        targetValue: 1000,
        startAt: new Date(),
        targetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdByUserId: userId,
      },
      select: { id: true },
    })

    const deleted = await (await import('../goals/[id]/route')).DELETE(
      req(`/api/goals/${goalId}`, { method: 'DELETE' }),
    )
    assert.equal(deleted.status, 200)

    const event = await findEvent('goal_abandoned', goalId)
    assert.ok(event, 'goal_abandoned event missing')
    assert.equal((event.context as any).kind, 'arr')

    // The archive itself must still have happened.
    const goal = await prisma.goal.findFirst({ where: { id: goalId, organizationId } })
    assert.equal(goal.status, 'archived')
  })

  test('negative signal: disconnecting an MCP connection writes connection_removed', async () => {
    const { id: connectionId } = await prisma.mcpConnection.create({
      data: {
        organizationId,
        userId,
        name: 'QA Disconnect Target',
        serverUrl: 'https://example.com/qa-mcp',
        authType: 'none',
        authConfig: {},
        isActive: true,
      },
      select: { id: true },
    })

    // The handler's tail calls Next's `after()`, which has no request scope in
    // this harness and throws. That is exactly the point of the assertion
    // below: capture is ordered BEFORE the best-effort purge, so the ledger
    // row survives a failing cleanup rather than being lost with it.
    await (await import('../mcp-connections/route'))
      .DELETE(req(`/api/mcp-connections?id=${connectionId}`, { method: 'DELETE' }))
      .catch(() => undefined)

    const gone = await prisma.mcpConnection.findFirst({ where: { id: connectionId, organizationId } })
    assert.equal(gone, null, 'the connection should have been deleted')

    const event = await findEvent('connection_removed', connectionId)
    assert.ok(event, 'connection_removed event missing')
    assert.equal((event.context as any).provider, 'QA Disconnect Target')
  })

  test('k-anonymity: a template only one org deployed never reaches the aggregate', async () => {
    const { aggregateTemplateAdoption } = await import('@/lib/templates/aggregate-adoption')
    await seedDeploy(organizationId, 'qa-solo', 'qa-res-1')
    await seedDeploy(organizationId, 'qa-solo', 'qa-res-2')

    await aggregateTemplateAdoption(systemPrisma, new Date(), 2)

    const row = await systemPrisma.templateAdoption.findUnique({
      where: { templateKey: 'seed:qa-solo' },
    })
    assert.equal(row, null, 'a single org must never produce an adoption row')
  })

  test('the aggregate materializes once a second org clears the floor', async () => {
    const { aggregateTemplateAdoption } = await import('@/lib/templates/aggregate-adoption')
    const other = await prisma.organization.create({
      data: { name: 'QA Peer', slug: `qa-peer-${crypto.randomUUID()}` },
    })
    try {
      await seedDeploy(other.id, 'qa-solo', 'qa-res-3')
      await aggregateTemplateAdoption(systemPrisma, new Date(), 2)

      const row = await systemPrisma.templateAdoption.findUnique({
        where: { templateKey: 'seed:qa-solo' },
      })
      assert.ok(row, 'row must exist once two orgs share the template')
      assert.equal(row.orgCount, 2)
      assert.equal(row.deploys, 3)
      // No deployed resource is ACTIVE — survival must not be inferred.
      assert.equal(row.surviving, 0)

      // The request-path loader now sees it, sourced from the aggregate.
      const { loadTemplateAdoptionScores } = await import('@/lib/templates/adoption')
      const scores = await loadTemplateAdoptionScores(systemPrisma)
      assert.deepEqual(scores['seed:qa-solo'], { deploys: 3, surviving: 0 })
    } finally {
      await prisma.organization.delete({ where: { id: other.id } }).catch(() => {})
    }
  })

  test('maintenance: a row that stops qualifying is deleted, not left stale', async () => {
    const { aggregateTemplateAdoption } = await import('@/lib/templates/aggregate-adoption')
    // The peer org (and its ledger rows) were deleted above, so 'qa-solo' is
    // back to a single org and must be withdrawn rather than kept at its
    // last qualifying counts.
    await aggregateTemplateAdoption(systemPrisma, new Date(), 2)

    const row = await systemPrisma.templateAdoption.findUnique({
      where: { templateKey: 'seed:qa-solo' },
    })
    assert.equal(row, null, 'a decayed template must be withdrawn from the aggregate')

    const { loadTemplateAdoptionScores } = await import('@/lib/templates/adoption')
    const scores = await loadTemplateAdoptionScores(systemPrisma)
    assert.equal(scores['seed:qa-solo'], undefined)
  })
}
