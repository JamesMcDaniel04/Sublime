/**
 * A restricted goal is ABSENT, not forbidden.
 *
 * 403 confirms the goal exists, which for a confidential goal is most of the
 * secret. Every assertion here is about absence: 404s, and missing rows in
 * lists — never a "denied" response.
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

  const restrictedGoal = (organizationId: string) => ({
    organizationId,
    name: 'Project Atlas',
    kind: 'kpi',
    startValue: 0,
    targetValue: 10,
    targetDate: new Date(Date.now() + 86_400_000 * 30),
    status: 'active',
    access: 'restricted',
    ownerUserId: null,
  })

  describe('restricted goals', () => {
    test('a non-member gets 404, never 403', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        await assert.rejects(
          () => resolveGoalScope(seeded.auth, goal.id),
          (error: any) => {
            assert.equal(error.status, 404, 'must be 404 — 403 confirms the goal exists')
            return true
          },
        )
      } finally {
        await seeded.cleanup()
      }
    })

    test('a non-member does not see it in the goals list', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        const { GET } = await import('../goals/route')
        const body = await (await GET(req('/api/goals'))).json()
        assert.ok(!body.goals.some((entry: any) => entry.id === goal.id), 'restricted goal leaked into the list')
      } finally {
        await seeded.cleanup()
      }
    })

    test('an unrestricted org goal is still visible to a member', async () => {
      // The counterpart: proves the absence above is caused by `access`, not by
      // the member simply being unable to see org goals at all.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({
          data: { ...restrictedGoal(seeded.organizationId), name: 'Open goal', access: 'workspace' },
        })
        const { GET } = await import('../goals/route')
        const body = await (await GET(req('/api/goals'))).json()
        assert.ok(body.goals.some((entry: any) => entry.id === goal.id))
      } finally {
        await seeded.cleanup()
      }
    })

    test('a member of the goal resolves it', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        await prisma.goalMember.create({ data: { goalId: goal.id, userId: seeded.userId } })
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        const scope = await resolveGoalScope(seeded.auth, goal.id)
        assert.equal(scope.kind, 'goal')
      } finally {
        await seeded.cleanup()
      }
    })

    test('a workspace admin resolves it without membership', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        const { resolveGoalScope } = await import('@/lib/server/goal-scope')
        const scope = await resolveGoalScope(seeded.auth, goal.id)
        assert.equal(scope.kind, 'goal')
      } finally {
        await seeded.cleanup()
      }
    })

    test("an admin's goals list does NOT include another member's personal goal", async () => {
      // Piece A's rule: admin reach is elevated, never ambient. Reading a
      // colleague's personal goal is an explicit withElevatedAccess act, not
      // something that happens because you opened the goals page.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const stranger = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const theirs = await prisma.goal.create({
          data: { ...restrictedGoal(seeded.organizationId), name: 'Their private goal', access: 'workspace', ownerUserId: stranger.id },
        })
        const { GET } = await import('../goals/route')
        const body = await (await GET(req('/api/goals'))).json()
        assert.ok(
          !body.goals.some((entry: any) => entry.id === theirs.id),
          "an admin's ordinary list must not fill with colleagues' personal goals",
        )
      } finally {
        await seeded.cleanup()
      }
    })
  })

  describe('anonymised work queue', () => {
    const workRow = (organizationId: string, goalId: string, assigneeUserId: string) => ({
      organizationId,
      goalId,
      resourceType: 'agent',
      resourceId: 'a1',
      subject: 'Follow up with Acme',
      produced: 'draft',
      body: 'Draft body',
      signals: { pipelineValue: 40000 },
      assigneeUserId,
    })

    test('a non-member assignee keeps their work item without the goals context', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        await prisma.goalWork.create({ data: workRow(seeded.organizationId, goal.id, seeded.userId) })

        const { GET } = await import('../goals/[id]/work/route')
        const response = await GET(req(`/api/goals/${goal.id}/work`))
        assert.equal(response.status, 200)
        const body = await response.json()
        assert.equal(body.anonymised, true)
        assert.equal(body.items[0].subject, 'Follow up with Acme')
        assert.equal(body.items[0].signals, undefined, 'signals leak the goal shape')
        assert.equal(body.items[0].goalId, undefined)
        // The funnel is a property of the GOAL, so publishing it would leak
        // exactly what hiding the goal was meant to withhold.
        assert.equal(body.stats, null)
      } finally {
        await seeded.cleanup()
      }
    })

    test('a non-member with NO assigned work still gets 404', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        const { GET } = await import('../goals/[id]/work/route')
        assert.equal((await GET(req(`/api/goals/${goal.id}/work`))).status, 404)
      } finally {
        await seeded.cleanup()
      }
    })

    test('a non-member cannot read work assigned to SOMEONE ELSE', async () => {
      // The anonymised branch must return only the caller's own rows, or it
      // becomes a way to read a restricted goal's whole queue.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        const stranger = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        await prisma.goalWork.create({ data: workRow(seeded.organizationId, goal.id, stranger.id) })
        await prisma.goalWork.create({
          data: { ...workRow(seeded.organizationId, goal.id, seeded.userId), subject: 'Mine' },
        })

        const { GET } = await import('../goals/[id]/work/route')
        const body = await (await GET(req(`/api/goals/${goal.id}/work`))).json()
        assert.equal(body.items.length, 1)
        assert.equal(body.items[0].subject, 'Mine')
      } finally {
        await seeded.cleanup()
      }
    })

    test('a goal member gets the full, unanonymised queue', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        await prisma.goalMember.create({ data: { goalId: goal.id, userId: seeded.userId } })
        await prisma.goalWork.create({ data: workRow(seeded.organizationId, goal.id, seeded.userId) })

        const { GET } = await import('../goals/[id]/work/route')
        const body = await (await GET(req(`/api/goals/${goal.id}/work`))).json()
        assert.notEqual(body.anonymised, true)
        assert.ok(body.stats, 'a member should get the funnel')
        assert.ok(body.items[0].signals, 'a member should get the signals')
      } finally {
        await seeded.cleanup()
      }
    })

    test("a member cannot read the work queue of a colleague's personal goal", async () => {
      // Pre-existing hole this closes: the route checked only organizationId, so
      // any member could read a personal goal's queue by guessing its id.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const stranger = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const theirs = await prisma.goal.create({
          data: { ...restrictedGoal(seeded.organizationId), access: 'workspace', ownerUserId: stranger.id },
        })
        const { GET } = await import('../goals/[id]/work/route')
        assert.equal((await GET(req(`/api/goals/${theirs.id}/work`))).status, 404)
      } finally {
        await seeded.cleanup()
      }
    })
  })

  describe('managing restriction', () => {
    const json = (path: string, method: string, body: unknown) =>
      new NextRequest(new URL(`http://test${path}`), {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      } as never)

    test('a MEMBER cannot restrict a goal', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({
          data: { ...restrictedGoal(seeded.organizationId), access: 'workspace' },
        })
        const { PATCH } = await import('../goals/[id]/members/route')
        const response = await PATCH(json(`/api/goals/${goal.id}/members`, 'PATCH', { access: 'restricted' }))
        assert.equal(response.status, 403)
      } finally {
        await seeded.cleanup()
      }
    })

    test('an ADMIN restricts a goal, adds a member, and it is audited', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({
          data: { ...restrictedGoal(seeded.organizationId), access: 'workspace' },
        })
        const { PATCH, POST } = await import('../goals/[id]/members/route')
        assert.equal((await PATCH(json(`/api/goals/${goal.id}/members`, 'PATCH', { access: 'restricted' }))).status, 200)
        assert.equal((await POST(json(`/api/goals/${goal.id}/members`, 'POST', { userId: seeded.userId }))).status, 200)

        const updated = await prisma.goal.findFirst({
          where: { id: goal.id, organizationId: seeded.organizationId },
        })
        assert.equal(updated.access, 'restricted')
        assert.equal(await prisma.goalMember.count({ where: { goalId: goal.id } }), 1)

        // Changing who can see a goal is a cross-owner act on shared work, so it
        // must land in the audit log. recordAudit is fire-and-forget, so poll.
        let row: any = null
        for (let attempt = 0; attempt < 20 && !row; attempt++) {
          row = await prisma.auditEvent.findFirst({
            where: { organizationId: seeded.organizationId, resourceType: 'goal', resourceId: goal.id },
          })
          if (!row) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.ok(row, 'expected an audit row for the access change')
      } finally {
        await seeded.cleanup()
      }
    })

    test('adding the same member twice is idempotent, not an error', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        const { POST } = await import('../goals/[id]/members/route')
        assert.equal((await POST(json(`/api/goals/${goal.id}/members`, 'POST', { userId: seeded.userId }))).status, 200)
        assert.equal((await POST(json(`/api/goals/${goal.id}/members`, 'POST', { userId: seeded.userId }))).status, 200)
        assert.equal(await prisma.goalMember.count({ where: { goalId: goal.id } }), 1)
      } finally {
        await seeded.cleanup()
      }
    })

    test('a personal goal cannot be restricted', async () => {
      // ownerUserId already restricts it; two mechanisms for one idea is how
      // contradictions get built.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const personal = await prisma.goal.create({
          data: { ...restrictedGoal(seeded.organizationId), access: 'workspace', ownerUserId: seeded.userId },
        })
        const { PATCH } = await import('../goals/[id]/members/route')
        const response = await PATCH(json(`/api/goals/${personal.id}/members`, 'PATCH', { access: 'restricted' }))
        assert.equal(response.status, 400)
        assert.equal((await response.json()).code, 'PERSONAL_GOAL')
      } finally {
        await seeded.cleanup()
      }
    })

    test('a member outside the workspace cannot be added', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      const other = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        const { POST } = await import('../goals/[id]/members/route')
        const response = await POST(json(`/api/goals/${goal.id}/members`, 'POST', { userId: other.userId }))
        assert.equal(response.status, 404)
      } finally {
        await seeded.cleanup()
        await other.cleanup()
      }
    })

    test('removing a member revokes their access again', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goal = await prisma.goal.create({ data: restrictedGoal(seeded.organizationId) })
        await prisma.goalMember.create({ data: { goalId: goal.id, userId: seeded.userId } })
        const { DELETE } = await import('../goals/[id]/members/route')
        const url = `/api/goals/${goal.id}/members?userId=${encodeURIComponent(seeded.userId)}`
        assert.equal((await DELETE(new NextRequest(new URL(`http://test${url}`), { method: 'DELETE' } as never))).status, 200)
        assert.equal(await prisma.goalMember.count({ where: { goalId: goal.id } }), 0)
      } finally {
        await seeded.cleanup()
      }
    })
  })
}
