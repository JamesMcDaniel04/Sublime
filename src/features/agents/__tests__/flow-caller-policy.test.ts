/**
 * `callerPolicy` enforcement, driven through the real resolver.
 *
 * Sublime's `flow:` tool plane does something n8n cannot — hand an agent an
 * entire flow as a tool — without n8n's corresponding control. Any ACTIVE
 * flow was agent-callable, with no way for its author to opt out short of
 * deactivating it. A flow that posts to a customer channel should be able to
 * say "not from an agent" and still run on its own schedule.
 *
 * There are two enforcement points and only one of them is the control:
 *
 *   loadFlowPlaneGroups  — does not OFFER a denied flow (convenience)
 *   resolveFlowToolExecutor — REFUSES to run one (the control)
 *
 * The distinction matters because a tool binding saved while a flow was
 * callable is stored on the agent. It never passes through the picker again,
 * so a picker-only check would let every pre-existing binding straight
 * through after the policy changed. That is the case this file exists for.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  test('flow caller policy', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { resolveFlowToolExecutor, loadFlowPlaneGroups } = await import('../tool-planes')

    const seeded = await seedTestOrg(prisma)
    after(async () => {
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    // A real graph: loadFlowPlaneGroups parses publishedGraph ?? graph and
    // skips anything that fails, so an empty {} would make BOTH flows absent
    // and the picker assertion below would pass for the wrong reason.
    const GRAPH = {
      nodes: [{ id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { triggerType: 'manual' } }],
      edges: [],
    }

    const makeFlow = (name: string, metadata: Record<string, unknown> | null) =>
      prisma.flow.create({
        data: {
          name,
          status: 'ACTIVE',
          graph: GRAPH as never,
          publishedGraph: GRAPH as never,
          organizationId: seeded.auth.organizationId,
          userId: seeded.auth.dbUser.id,
          ...(metadata ? { metadata: metadata as never } : {}),
        },
      })

    const open = await makeFlow(`open-${Date.now()}`, null)
    const denied = await makeFlow(`denied-${Date.now()}`, { callerPolicy: 'none' })

    const resolve = (id: string) =>
      resolveFlowToolExecutor({
        organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id,
        plane: 'flow',
        ref: id,
        toolName: 'run',
      })

    await t.test('a flow with no policy still resolves — existing agents keep working', async () => {
      const executor = await resolve(open.id)
      assert.equal(executor.provider, 'flow')
    })

    // The one that matters: this is the path a STORED binding takes.
    await t.test('a denied flow is refused at resolution, not merely hidden', async () => {
      await assert.rejects(() => resolve(denied.id), /caller policy|not available to agents/i)
    })

    await t.test('the refusal names the flow so the author can find it', async () => {
      await assert.rejects(() => resolve(denied.id), (error: Error) => error.message.includes(denied.name))
    })

    await t.test('a denied flow is not offered in the picker either', async () => {
      const groups = await loadFlowPlaneGroups(seeded.auth.organizationId, seeded.auth.dbUser.id, {
        flowIds: [open.id, denied.id],
      })
      const offered = JSON.stringify(groups)
      assert.ok(offered.includes(open.name), 'the open flow should still be offered')
      assert.ok(!offered.includes(denied.name), 'the denied flow was offered to an agent')
    })

    // Denying agents must not deactivate the flow for its own trigger.
    await t.test('a denied flow is still ACTIVE and runnable by other means', async () => {
      const row = await prisma.flow.findFirst({
        where: { id: denied.id, organizationId: seeded.auth.organizationId },
        select: { status: true },
      })
      assert.equal(row?.status, 'ACTIVE')
    })
  })
} else {
  test('flow caller policy (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
