/**
 * The agent publish lifecycle, through the real route.
 *
 * The point of the feature is one sentence: editing a production agent must
 * not change what runs. Everything below exists to prove that end to end
 * rather than at the pure-function level, because the failure mode is a
 * config path somewhere still reading the live column.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const post = (id: string, body: unknown = {}) =>
    new NextRequest(new URL(`http://test/api/agents/${id}/publish`), {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)

  test('agent publish route', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { POST } = await import('../[id]/publish/route')
    const { agentConfigForRun, agentDraftDiffers } = await import('@/lib/agents/publish')

    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    after(async () => {
      clearTestAuth()
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    const makeAgent = () =>
      prisma.agentTask.create({
        data: {
          description: 'v1 description',
          objective: 'v1 objective',
          status: 'ACTIVE',
          organizationId: seeded.auth.organizationId,
          userId: seeded.auth.dbUser.id,
          metadata: { instructions: 'v1 instructions' } as never,
        },
      })

    const reload = (id: string) =>
      prisma.agentTask.findFirstOrThrow({ where: { id, organizationId: seeded.auth.organizationId } })

    await t.test('an unpublished agent runs its live config', async () => {
      const agent = await makeAgent()
      assert.equal(agentConfigForRun(agent).objective, 'v1 objective')
      assert.equal(agent.publishedConfig, null)
    })

    await t.test('publishing snapshots the config and bumps the version', async () => {
      const agent = await makeAgent()
      const body = await (await POST(post(agent.id))).json()
      assert.equal(body.published, true)
      assert.equal(body.version, agent.version + 1)

      const after = await reload(agent.id)
      assert.ok(after.publishedConfig, 'publishedConfig should be set')
      assert.ok(after.publishedAt, 'publishedAt should be stamped')
    })

    // THE test. Everything else is scaffolding around this one.
    await t.test('editing a published agent does not change what a run executes', async () => {
      const agent = await makeAgent()
      await POST(post(agent.id))

      await prisma.agentTask.update({
        where: { id: agent.id, organizationId: seeded.auth.organizationId },
        data: { objective: 'edited after publish', metadata: { instructions: 'edited instructions' } as never },
      })

      const edited = await reload(agent.id)
      const running = agentConfigForRun(edited)
      assert.equal(running.objective, 'v1 objective', 'the run picked up an unpublished edit')
      assert.equal((running.metadata as { instructions?: string }).instructions, 'v1 instructions')
      assert.equal(agentDraftDiffers(edited), true, 'the edit should show as an unpublished change')
    })

    await t.test('publishing again promotes the draft', async () => {
      const agent = await makeAgent()
      await POST(post(agent.id))
      await prisma.agentTask.update({
        where: { id: agent.id, organizationId: seeded.auth.organizationId },
        data: { objective: 'v2 objective' },
      })
      await POST(post(agent.id))

      const after = await reload(agent.id)
      assert.equal(agentConfigForRun(after).objective, 'v2 objective')
      assert.equal(agentDraftDiffers(after), false)
    })

    await t.test('revert throws the draft away and restores the published copy', async () => {
      const agent = await makeAgent()
      await POST(post(agent.id))
      await prisma.agentTask.update({
        where: { id: agent.id, organizationId: seeded.auth.organizationId },
        data: { objective: 'a change I regret' },
      })

      const body = await (await POST(post(agent.id, { revert: true }))).json()
      assert.equal(body.reverted, true)
      const after = await reload(agent.id)
      assert.equal(after.objective, 'v1 objective')
      assert.equal(agentDraftDiffers(after), false)
    })

    await t.test('reverting an agent that was never published is refused, not silently ignored', async () => {
      const agent = await makeAgent()
      const response = await POST(post(agent.id, { revert: true }))
      assert.ok(response.status >= 400)
      assert.match(JSON.stringify(await response.json()), /never been published/i)
    })

    // Unpublishing must not take a working agent offline — status is a
    // separate axis on purpose.
    await t.test('unpublish returns to live-on-save and leaves status alone', async () => {
      const agent = await makeAgent()
      await POST(post(agent.id))
      await POST(post(agent.id, { unpublish: true }))

      const after = await reload(agent.id)
      assert.equal(after.publishedConfig, null)
      assert.equal(after.status, 'ACTIVE', 'unpublishing should not deactivate the agent')
      assert.equal(agentDraftDiffers(after), false)
    })

    await t.test('another workspace cannot publish this agent', async () => {
      const other = await seedTestOrg(prisma)
      const agent = await makeAgent()
      installTestAuth(other.auth)
      const response = await POST(post(agent.id))
      assert.equal(response.status, 404)
      installTestAuth(seeded.auth)
      await other.cleanup()
    })
  })
} else {
  test('agent publish route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
