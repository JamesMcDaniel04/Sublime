import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    await prisma.agentTask.create({
      data: {
        description: 'Context agent',
        objective: 'o',
        status: 'ACTIVE',
        agentType: 'CUSTOM',
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        metadata: { title: 'Context Agent', integrations: ['slack'] },
      },
    })
    await prisma.flow.create({
      data: { name: 'Context flow', organizationId: seeded.organizationId, userId: seeded.userId },
    })
  })

  after(async () => {
    // Guard: if before() threw (seed failure), seeded is undefined — don't
    // throw a secondary error over the real one.
    if (seeded) await seeded.cleanup()
  })

  test('includes this org agents and flows', async () => {
    const { buildWorkspaceContext } = await import('../workspace-context')
    const context = await buildWorkspaceContext({
      organizationId: seeded.organizationId,
      dbUser: { id: seeded.userId },
    })
    assert.ok(context.agents.some((agent: any) => agent.title === 'Context Agent'))
    assert.ok(context.flows.some((flow: any) => flow.name === 'Context flow'))
    // Connections come from the live stores (Nango / MCP) only — the legacy
    // always-false `oauth` map was removed.
    assert.ok('nango' in context.connections)
    assert.ok('mcp' in context.connections)
    assert.ok(!('oauth' in context.connections))
  })

  test('excludes other-org data', async () => {
    const { buildWorkspaceContext } = await import('../workspace-context')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const other = await seedTestOrg(prisma)
    try {
      const context = await buildWorkspaceContext({
        organizationId: other.organizationId,
        dbUser: { id: other.userId },
      })
      assert.equal(context.agents.length, 0)
      assert.equal(context.flows.length, 0)
    } finally {
      await other.cleanup()
    }
  })
} else {
  test('workspace-context tests need TEST_DATABASE_URL', { skip: true }, () => {})
}
