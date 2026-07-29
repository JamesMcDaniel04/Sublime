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

  describe('integrations lens', () => {
    test('scoping keeps the tools a goals metrics bind to, and drops the rest', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({
          data: {
            organizationId: seeded.organizationId, name: 'Revenue', kind: 'arr',
            startValue: 0, targetValue: 100,
            targetDate: new Date(Date.now() + 86_400_000 * 30), status: 'active',
          },
        })
        // A Salesforce-bound metric. connectionRef is 'nango:<id>' — an INSTANCE
        // id, not a connector key — which is why the lens maps on `source`.
        await prisma.nangoConnection.create({
          data: {
            organizationId: seeded.organizationId,
            connectionId: 'conn_1', providerConfigKey: 'salesforce', status: 'connected',
          },
        })
        await prisma.goalMetric.create({
          data: {
            organizationId: seeded.organizationId, goalId: goal.id, role: 'primary',
            source: 'salesforce', metricKey: 'salesforce.pipeline', connectionRef: 'nango:conn_1',
          },
        })

        const { GET } = await import('../integrations/available/route')
        const unscoped = await (await GET(req('/api/integrations/available'))).json()
        const scoped = await (await GET(req(`/api/integrations/available?goal=${goal.id}`))).json()

        const scopedKeys = scoped.tools.map((tool: any) => tool.key)
        assert.ok(scopedKeys.includes('salesforce'), 'the goal-bound tool should survive the lens')
        assert.ok(!scopedKeys.includes('Slack'), 'a tool the goal does not bind to should be filtered out')
        assert.ok(scoped.tools.length < unscoped.tools.length, 'the lens did not filter')

        // The ratio ships even when nothing is filtered out, because the
        // affordance is what stops a scoped page reading as a broken one.
        assert.equal(typeof scoped.totalCount, 'number')
        assert.equal(scoped.totalCount, unscoped.tools.length)
        assert.equal(scoped.unlinkedCount, scoped.totalCount - scoped.tools.length)
      } finally {
        await seeded.cleanup()
      }
    })
  })

  describe('integrations catalog lens', () => {
    test('the connect catalog scopes to what the goals metrics bind to', async () => {
      // This is the endpoint the integrations PAGE reads (/api/nango/integrations),
      // as opposed to /api/integrations/available which feeds agent tool pickers.
      // Under test both Nango and Google OAuth are unconfigured, so the catalog
      // is deterministically the single unconditional Postgres tile.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      const goalData = (name: string) => ({
        organizationId: seeded.organizationId, name, kind: 'kpi',
        startValue: 0, targetValue: 10,
        targetDate: new Date(Date.now() + 86_400_000 * 30), status: 'active',
      })
      try {
        const { GET } = await import('../nango/integrations/route')
        const unscoped = await (await GET(req('/api/nango/integrations'))).json()
        const catalogIds = unscoped.integrations.map((entry: any) => entry.id)
        assert.deepEqual(catalogIds, ['postgres'], 'test catalog assumption changed')

        // A goal bound to Postgres keeps the Postgres tile.
        const bound = await prisma.goal.create({ data: goalData('Postgres goal') })
        await prisma.goalMetric.create({
          data: {
            organizationId: seeded.organizationId, goalId: bound.id, role: 'primary',
            source: 'postgres', metricKey: 'pg.count', connectionRef: 'postgres:abc',
          },
        })
        const scoped = await (await GET(req(`/api/nango/integrations?goal=${bound.id}`))).json()
        assert.deepEqual(scoped.integrations.map((e: any) => e.id), ['postgres'])
        assert.equal(scoped.totalCount, 1)
        assert.equal(scoped.unlinkedCount, 0)

        // A goal bound only to manual entry binds no connectable integration,
        // so the catalog empties — and the ratio is what explains that rather
        // than leaving the page looking broken.
        const manual = await prisma.goal.create({ data: goalData('Manual goal') })
        await prisma.goalMetric.create({
          data: {
            organizationId: seeded.organizationId, goalId: manual.id, role: 'primary',
            source: 'manual', metricKey: 'manual.value',
          },
        })
        const empty = await (await GET(req(`/api/nango/integrations?goal=${manual.id}`))).json()
        assert.deepEqual(empty.integrations, [])
        assert.equal(empty.totalCount, 1)
        assert.equal(empty.unlinkedCount, 1)

        // The remainder must stay reachable — a lens that makes an integration
        // unreachable would strand anyone trying to connect a new source.
        const rest = await (await GET(req(`/api/nango/integrations?goal=${manual.id}&unlinked=1`))).json()
        assert.deepEqual(rest.integrations.map((e: any) => e.id), ['postgres'])
      } finally {
        await seeded.cleanup()
      }
    })
  })

  describe('all-goals plan gate', () => {
    const goalData = (organizationId: string, name: string) => ({
      organizationId, name, kind: 'kpi', startValue: 0, targetValue: 10,
      targetDate: new Date(Date.now() + 86_400_000 * 30), status: 'active',
    })

    test('Individual with two active goals is refused the all-goals scope', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN', plan: 'STARTER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        await prisma.goal.create({ data: goalData(seeded.organizationId, 'One') })
        await prisma.goal.create({ data: goalData(seeded.organizationId, 'Two') })
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        await assert.rejects(
          () => resolveGoalScope(seeded.auth, 'all'),
          (error: any) => error.code === 'PLAN_LIMIT',
        )
      } finally {
        await seeded.cleanup()
      }
    })

    test('Individual with one active goal is allowed it', async () => {
      // Without this exception the gate locks an Individual workspace out of
      // the page that creates its first goal. One goal has nothing to
      // aggregate, so nothing is given away.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN', plan: 'STARTER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        await prisma.goal.create({ data: goalData(seeded.organizationId, 'Only') })
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        assert.deepEqual(await resolveGoalScope(seeded.auth, 'all'), { kind: 'all' })
      } finally {
        await seeded.cleanup()
      }
    })

    test('an empty Individual workspace is allowed it', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN', plan: 'STARTER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        assert.deepEqual(await resolveGoalScope(seeded.auth, 'all'), { kind: 'all' })
      } finally {
        await seeded.cleanup()
      }
    })

    test('Team plan is allowed it regardless of goal count', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN', plan: 'PROFESSIONAL' })
      testAuth.installTestAuth(seeded.auth)
      try {
        await prisma.goal.create({ data: goalData(seeded.organizationId, 'One') })
        await prisma.goal.create({ data: goalData(seeded.organizationId, 'Two') })
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        assert.deepEqual(await resolveGoalScope(seeded.auth, 'all'), { kind: 'all' })
      } finally {
        await seeded.cleanup()
      }
    })

    test('an unknown goal id is 404, never 403', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        await assert.rejects(
          () => resolveGoalScope(seeded.auth, 'goal_does_not_exist'),
          (error: any) => error.status === 404,
        )
      } finally {
        await seeded.cleanup()
      }
    })

    test('another members personal goal is not a scope you can select', async () => {
      // Not in the plan, but the resolver's goalReadWhere is the only thing
      // stopping /g/<their-goal>/flows from working, so it deserves an assertion.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const stranger = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const theirs = await prisma.goal.create({
          data: { ...goalData(seeded.organizationId, 'Theirs'), ownerUserId: stranger.id },
        })
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        await assert.rejects(
          () => resolveGoalScope(seeded.auth, theirs.id),
          (error: any) => error.status === 404,
        )
      } finally {
        await seeded.cleanup()
      }
    })
  })
}
