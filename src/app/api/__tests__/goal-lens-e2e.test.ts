/**
 * The lens narrows, never widens.
 *
 * The central security property of the goal lens: a scoped list must always be
 * a subset of the same actor's unscoped list. The bug this guards against is
 * fetching resources by contribution id alone, which bypasses visibility.ts and
 * surfaces a colleague's private flow because it happens to serve your goal.
 */
import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let testAuth: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    testAuth = await import('@/lib/server/__tests__/test-auth')
  })

  const req = (path: string) => new NextRequest(new URL(`http://test${path}`))

  describe('flows lens', () => {
    test('a scoped list is a subset of the unscoped list, and excludes another users private flow', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({
          data: {
            organizationId: seeded.organizationId,
            name: 'Q3 ARR',
            kind: 'arr',
            startValue: 0,
            targetValue: 100,
            targetDate: new Date(Date.now() + 86_400_000 * 30),
            status: 'active',
          },
        })

        const mine = await prisma.flow.create({
          data: { name: 'Mine', organizationId: seeded.organizationId, userId: seeded.userId },
        })
        // Another member's PRIVATE flow that also contributes to the goal. The
        // lens must not surface it; only a contribution-id-only fetch would.
        const stranger = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const theirs = await prisma.flow.create({
          data: { name: 'Theirs', organizationId: seeded.organizationId, userId: stranger.id, visibility: 'private' },
        })

        for (const flow of [mine, theirs]) {
          await prisma.goalContribution.create({
            data: {
              organizationId: seeded.organizationId,
              goalId: goal.id,
              resourceType: 'flow',
              resourceId: flow.id,
              origin: 'manual',
            },
          })
        }
        // A flow linked to no goal at all — must be counted, not listed.
        await prisma.flow.create({
          data: { name: 'Unlinked', organizationId: seeded.organizationId, userId: seeded.userId },
        })

        const { GET } = await import('../flows/route')
        const unscoped = await (await GET(req('/api/flows'))).json()
        const scoped = await (await GET(req(`/api/flows?goal=${goal.id}`))).json()

        const unscopedIds = new Set(unscoped.flows.map((f: any) => f.id))
        const scopedIds = scoped.flows.map((f: any) => f.id)

        // The property.
        for (const id of scopedIds) assert.ok(unscopedIds.has(id), `${id} appeared only when scoped`)
        // The specific bug.
        assert.ok(!scopedIds.includes(theirs.id), "another member's private flow leaked through the lens")
        assert.ok(scopedIds.includes(mine.id))
        assert.equal(scoped.unlinkedCount, 1)
      } finally {
        await seeded.cleanup()
      }
    })
  })

  describe('agents lens', () => {
    test('a scoped agent list is a subset and excludes another users private agent', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({
          data: {
            organizationId: seeded.organizationId,
            name: 'Churn',
            kind: 'kpi',
            startValue: 0,
            targetValue: 10,
            targetDate: new Date(Date.now() + 86_400_000 * 30),
            status: 'active',
          },
        })
        const mine = await prisma.agentTask.create({
          data: {
            description: 'mine', objective: 'o', status: 'ACTIVE', agentType: 'assistant',
            organizationId: seeded.organizationId, userId: seeded.userId,
          },
        })
        const stranger = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const theirs = await prisma.agentTask.create({
          data: {
            description: 'theirs', objective: 'o', status: 'ACTIVE', agentType: 'assistant',
            organizationId: seeded.organizationId, userId: stranger.id, visibility: 'private',
          },
        })
        // Mine, but contributing to NOTHING. This is the row that discriminates
        // a real lens from a no-op: agentReadScope already hides the stranger's
        // private agent, so without this the test would pass on an unscoped
        // handler and prove nothing.
        const unlinked = await prisma.agentTask.create({
          data: {
            description: 'unlinked', objective: 'o', status: 'ACTIVE', agentType: 'assistant',
            organizationId: seeded.organizationId, userId: seeded.userId,
          },
        })
        for (const agent of [mine, theirs]) {
          await prisma.goalContribution.create({
            data: {
              organizationId: seeded.organizationId, goalId: goal.id,
              resourceType: 'agent', resourceId: agent.id, origin: 'manual',
            },
          })
        }

        const { GET } = await import('../agents/route')
        const unscoped = await (await GET(req('/api/agents'))).json()
        const scoped = await (await GET(req(`/api/agents?goal=${goal.id}`))).json()

        const unscopedIds = new Set(unscoped.agents.map((a: any) => a.id))
        const scopedIds = scoped.agents.map((a: any) => a.id)
        for (const id of scopedIds) assert.ok(unscopedIds.has(id), `${id} appeared only when scoped`)
        assert.ok(!scopedIds.includes(theirs.id), "another member's private agent leaked through the lens")
        assert.ok(scopedIds.includes(mine.id))
        // The discriminating assertions.
        assert.ok(unscopedIds.has(unlinked.id), 'the unlinked agent should be in the unscoped list')
        assert.ok(!scopedIds.includes(unlinked.id), 'the lens did not filter — an unlinked agent survived it')
        assert.equal(scoped.unlinkedCount, 1)
      } finally {
        await seeded.cleanup()
      }
    })
  })
}
