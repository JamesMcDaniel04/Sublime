/**
 * Admin surfaces: insights, per-member takeover, reassignment.
 *
 * Every gate is tested from the REFUSAL side as well as the granted side, and
 * insights are pinned to an aggregate-only allow-list — the same discipline as
 * the anonymised work serializer: a future field carrying content fails a test
 * rather than shipping.
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
  const json = (path: string, method: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } as never)

  describe('insights', () => {
    test('a MEMBER is refused', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const { GET } = await import('../settings/insights/route')
        assert.equal((await GET(req('/api/settings/insights'))).status, 403)
      } finally {
        await seeded.cleanup()
      }
    })

    test('adoption lists every member including the never-active, aggregate-only', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const idle = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, name: 'Idle' },
        })
        await prisma.userEvent.create({
          data: {
            organizationId: seeded.organizationId, userId: seeded.auth.dbUser.id,
            kind: 'flow_created', resourceType: 'flow', resourceId: 'f1',
          },
        })
        await prisma.userEvent.create({
          data: {
            organizationId: seeded.organizationId, userId: seeded.auth.dbUser.id,
            kind: 'agent_run_manual', resourceType: 'agent', resourceId: 'a1',
          },
        })

        const { GET } = await import('../settings/insights/route')
        const body = await (await GET(req('/api/settings/insights'))).json()

        assert.equal(body.adoption.length, 2, 'both members appear, active or not')
        const active = body.adoption.find((row: any) => row.userId === seeded.auth.dbUser.id)
        const never = body.adoption.find((row: any) => row.userId === idle.id)
        assert.equal(active.runs, 1)
        assert.equal(active.flowsCreated, 1)
        assert.ok(active.lastActiveAt)
        assert.equal(never.runs, 0)
        assert.equal(never.lastActiveAt, null)

        // The aggregate-only allow-list. A field carrying content (a prompt, a
        // run result, a work body) must fail here, not ship.
        const ADOPTION_KEYS = ['userId', 'name', 'email', 'lastActiveAt', 'runs', 'flowsCreated', 'agentsCreated', 'tokensUsed'].sort()
        for (const row of body.adoption) {
          assert.deepEqual(Object.keys(row).sort(), ADOPTION_KEYS)
        }
      } finally {
        await seeded.cleanup()
      }
    })

    test('contribution aggregates per goal and never crosses orgs', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      const other = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const goalData = (organizationId: string, name: string) => ({
          organizationId, name, kind: 'kpi', startValue: 0, targetValue: 10,
          targetDate: new Date(Date.now() + 86_400_000 * 30), status: 'active',
        })
        const goal = await prisma.goal.create({ data: goalData(seeded.organizationId, 'Mine') })
        const foreign = await prisma.goal.create({ data: goalData(other.organizationId, 'Theirs') })
        await prisma.goalWork.create({
          data: {
            organizationId: seeded.organizationId, goalId: goal.id,
            resourceType: 'agent', resourceId: 'a1', subject: 's', produced: 'draft',
            assigneeUserId: seeded.auth.dbUser.id, disposition: 'used',
          },
        })
        await prisma.goalWork.create({
          data: {
            organizationId: other.organizationId, goalId: foreign.id,
            resourceType: 'agent', resourceId: 'a2', subject: 's2', produced: 'draft',
          },
        })

        const { GET } = await import('../settings/insights/route')
        const body = await (await GET(req('/api/settings/insights'))).json()

        assert.equal(body.contribution.length, 1, "another org's goal leaked into insights")
        assert.equal(body.contribution[0].goalId, goal.id)
        assert.equal(body.contribution[0].used, 1)
      } finally {
        await seeded.cleanup()
        await other.cleanup()
      }
    })
  })

  describe('per-member takeover', () => {
    test('a MEMBER is refused the resource listing and reassign', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const resources = await import('../settings/members/[id]/resources/route')
        const reassign = await import('../settings/members/[id]/reassign/route')
        assert.equal((await resources.GET(req(`/api/settings/members/${seeded.auth.dbUser.id}/resources`))).status, 403)
        assert.equal((await reassign.POST(json(`/api/settings/members/${seeded.auth.dbUser.id}/reassign`, 'POST', { resourceIds: ['x'], toUserId: 'y' }))).status, 403)
      } finally {
        await seeded.cleanup()
      }
    })

    test('the listing returns names only — no graphs, objectives, or content', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const owner = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, name: 'Owner' },
        })
        await prisma.flow.create({
          data: { name: 'Their flow', organizationId: seeded.organizationId, userId: owner.id, visibility: 'private' },
        })
        await prisma.agentTask.create({
          data: {
            description: 'their agent', objective: 'secret objective', status: 'ACTIVE', agentType: 'assistant',
            organizationId: seeded.organizationId, userId: owner.id,
          },
        })

        const { GET } = await import('../settings/members/[id]/resources/route')
        const body = await (await GET(req(`/api/settings/members/${owner.id}/resources`))).json()

        assert.equal(body.resources.length, 2)
        const RESOURCE_KEYS = ['id', 'name', 'type', 'updatedAt'].sort()
        for (const row of body.resources) {
          assert.deepEqual(Object.keys(row).sort(), RESOURCE_KEYS, 'listing must stay names-only')
        }

        // resource:takeover is documented as ALWAYS audited, and reading what a
        // colleague owns is precisely the cross-owner act the log exists to
        // record. Without this the listing was the one takeover path that left
        // no trace.
        let audit: any = null
        for (let attempt = 0; attempt < 20 && !audit; attempt++) {
          audit = await prisma.auditEvent.findFirst({
            where: {
              organizationId: seeded.organizationId,
              action: 'admin.resource.read',
              resourceId: owner.id,
            },
          })
          if (!audit) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.ok(audit, 'reading a member\'s owned work must land in the audit log')
        assert.equal((audit.detail as any).targetUserId, owner.id)
      } finally {
        await seeded.cleanup()
      }
    })

    test('reassign moves ownership and writes an audit row', async () => {
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const leaver = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const flow = await prisma.flow.create({
          data: { name: 'Orphan-to-be', organizationId: seeded.organizationId, userId: leaver.id },
        })

        const { POST } = await import('../settings/members/[id]/reassign/route')
        const response = await POST(json(`/api/settings/members/${leaver.id}/reassign`, 'POST', {
          resourceIds: [flow.id],
          toUserId: seeded.auth.dbUser.id,
        }))
        assert.equal(response.status, 200, await response.text())

        const moved = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: seeded.organizationId } })
        assert.equal(moved.userId, seeded.auth.dbUser.id)

        let row: any = null
        for (let attempt = 0; attempt < 20 && !row; attempt++) {
          row = await prisma.auditEvent.findFirst({
            where: { organizationId: seeded.organizationId, action: 'admin.resource.reassign', resourceId: flow.id },
          })
          if (!row) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.ok(row, 'reassignment must land in the audit log')
      } finally {
        await seeded.cleanup()
      }
    })

    test('reassign refuses an inactive target', async () => {
      // Otherwise offboarding strands the work a second time.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const leaver = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const suspended = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: false },
        })
        const flow = await prisma.flow.create({
          data: { name: 'F', organizationId: seeded.organizationId, userId: leaver.id },
        })
        const { POST } = await import('../settings/members/[id]/reassign/route')
        const response = await POST(json(`/api/settings/members/${leaver.id}/reassign`, 'POST', {
          resourceIds: [flow.id], toUserId: suspended.id,
        }))
        assert.equal(response.status, 400)
      } finally {
        await seeded.cleanup()
      }
    })

    test("reassign cannot move a resource the named member does not own", async () => {
      // The route is scoped to ONE member's resources; ids belonging to someone
      // else must be refused, or the endpoint becomes a general ownership editor.
      const seeded = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
      testAuth.installTestAuth(seeded.auth)
      try {
        const leaver = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const bystander = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true },
        })
        const theirs = await prisma.flow.create({
          data: { name: 'Bystander flow', organizationId: seeded.organizationId, userId: bystander.id },
        })
        const { POST } = await import('../settings/members/[id]/reassign/route')
        const response = await POST(json(`/api/settings/members/${leaver.id}/reassign`, 'POST', {
          resourceIds: [theirs.id], toUserId: seeded.auth.dbUser.id,
        }))
        assert.equal(response.status, 400)
        const untouched = await prisma.flow.findFirst({ where: { id: theirs.id, organizationId: seeded.organizationId } })
        assert.equal(untouched.userId, bystander.id)
      } finally {
        await seeded.cleanup()
      }
    })
  })
}
