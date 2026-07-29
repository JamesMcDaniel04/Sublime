/**
 * Negative authorization against the REAL route handlers.
 *
 * Positive-only authorization tests are how these defects ship: a suite that
 * only ever drives an admin proves the happy path works and says nothing about
 * whether the gate exists. Every test here asserts a REFUSAL.
 *
 * Uses the seeded-auth seam (installTestAuth), so handlers run exactly as they
 * do in production — same wrapper, same requireAuthContext path, same Prisma.
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

  const req = (path: string, init?: RequestInit) =>
    new NextRequest(new URL(`http://test${path}`), init as never)

  const jsonReq = (path: string, method: string, body: unknown) =>
    req(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  /** Seed a workspace, run `fn` with that auth installed, always clean up. */
  async function withSeeded(
    options: { role?: 'ADMIN' | 'MEMBER'; plan?: string },
    fn: (seeded: any) => Promise<void>,
  ): Promise<void> {
    const seeded = await testAuth.seedTestOrg(prisma, options)
    testAuth.installTestAuth(seeded.auth)
    try {
      await fn(seeded)
    } finally {
      await seeded.cleanup()
    }
  }

  describe('role gates', () => {
    test('a MEMBER is refused the workspace audit export', async () => {
      await withSeeded({ role: 'MEMBER' }, async () => {
        const { GET } = await import('../audit/export/route')
        const response = await GET(req('/api/audit/export'))
        assert.equal(response.status, 403)
        assert.equal((await response.json()).code, 'FORBIDDEN')
      })
    })

    test('a MEMBER is refused workspace intelligence insights', async () => {
      await withSeeded({ role: 'MEMBER' }, async () => {
        const { GET } = await import('../intelligence/health/route')
        const response = await GET(req('/api/intelligence/health'))
        assert.equal(response.status, 403)
      })
    })

    test('a MEMBER cannot invite anyone', async () => {
      await withSeeded({ role: 'MEMBER' }, async () => {
        const { POST } = await import('../settings/members/route')
        const response = await POST(jsonReq('/api/settings/members', 'POST', { email: 'x@example.com' }))
        assert.equal(response.status, 403)
      })
    })

    test('an ADMIN passes the same gates', async () => {
      // The counterpart to the refusals above: proves they fail for the RIGHT
      // reason (missing capability) rather than because the route is broken.
      await withSeeded({ role: 'ADMIN' }, async () => {
        const { GET } = await import('../audit/export/route')
        assert.equal((await GET(req('/api/audit/export'))).status, 200)
      })
    })

    test('a MEMBER cannot create an organization goal, but can create a personal one', async () => {
      await withSeeded({ role: 'MEMBER' }, async () => {
        const { POST } = await import('../goals/route')
        const body = {
          name: 'Org target',
          kind: 'kpi' as const,
          unit: 'count' as const,
          startValue: 0,
          targetValue: 100,
          targetDate: new Date(Date.now() + 86_400_000 * 30).toISOString(),
          metric: { source: 'manual', metricKey: 'demo' },
        }
        const orgGoal = await POST(jsonReq('/api/goals', 'POST', { ...body, personal: false }))
        assert.equal(orgGoal.status, 403)

        const personal = await POST(jsonReq('/api/goals', 'POST', { ...body, personal: true }))
        assert.equal(personal.status, 200, await personal.text())
      })
    })
  })

  describe('plan entitlements', () => {
    test('the active-goal cap blocks the second goal on Individual', async () => {
      await withSeeded({ role: 'ADMIN', plan: 'STARTER' }, async (seeded: any) => {
        // maxActiveGoals is 1 for STARTER, so seeding one active goal fills it.
        await prisma.goal.create({
          data: {
            organizationId: seeded.organizationId,
            name: 'First',
            kind: 'kpi',
            startValue: 0,
            targetValue: 100,
            targetDate: new Date(Date.now() + 86_400_000 * 30),
            status: 'active',
          },
        })
        const { POST } = await import('../goals/route')
        const response = await POST(jsonReq('/api/goals', 'POST', {
          name: 'Second',
          kind: 'kpi',
          unit: 'count',
          startValue: 0,
          targetValue: 100,
          targetDate: new Date(Date.now() + 86_400_000 * 30).toISOString(),
          metric: { source: 'manual', metricKey: 'demo' },
          personal: false,
        }))
        assert.equal(response.status, 403)
        assert.equal((await response.json()).code, 'PLAN_LIMIT')
      })
    })

    test('an archived goal frees a slot, so a downgrade never destroys work', async () => {
      await withSeeded({ role: 'ADMIN', plan: 'STARTER' }, async (seeded: any) => {
        await prisma.goal.create({
          data: {
            organizationId: seeded.organizationId,
            name: 'Archived',
            kind: 'kpi',
            startValue: 0,
            targetValue: 100,
            targetDate: new Date(Date.now() + 86_400_000 * 30),
            status: 'archived',
          },
        })
        const { POST } = await import('../goals/route')
        const response = await POST(jsonReq('/api/goals', 'POST', {
          name: 'New one',
          kind: 'kpi',
          unit: 'count',
          startValue: 0,
          targetValue: 100,
          targetDate: new Date(Date.now() + 86_400_000 * 30).toISOString(),
          metric: { source: 'manual', metricKey: 'demo' },
          personal: false,
        }))
        assert.equal(response.status, 200, await response.text())
      })
    })
  })

  describe('last-admin guard', () => {
    test('the sole admin cannot be demoted', async () => {
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        const { assertNotLastAdmin } = await import('@/lib/server/last-admin')
        await assert.rejects(
          () => assertNotLastAdmin(seeded.organizationId, seeded.userId),
          (error: any) => error.code === 'LAST_ADMIN',
        )
      })
    })

    test('demotion is allowed once a second admin exists', async () => {
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        await prisma.user.create({
          data: {
            supabaseId: crypto.randomUUID(),
            organizationId: seeded.organizationId,
            isActive: true,
            role: 'ADMIN',
          },
        })
        const { assertNotLastAdmin } = await import('@/lib/server/last-admin')
        await assertNotLastAdmin(seeded.organizationId, seeded.userId)
      })
    })

    test('a suspended second admin does not count', async () => {
      // The guard must consider ACTIVE admins only — a suspended admin cannot
      // administer anything, so leaving them as the sole "admin" still strands
      // the workspace.
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        await prisma.user.create({
          data: {
            supabaseId: crypto.randomUUID(),
            organizationId: seeded.organizationId,
            isActive: false,
            role: 'ADMIN',
          },
        })
        const { assertNotLastAdmin } = await import('@/lib/server/last-admin')
        await assert.rejects(
          () => assertNotLastAdmin(seeded.organizationId, seeded.userId),
          (error: any) => error.code === 'LAST_ADMIN',
        )
      })
    })

    test('the sole MEMBER of a workspace may still delete their account', async () => {
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        const { assertNotLastAdmin } = await import('@/lib/server/last-admin')
        // allowWhenSoleMember: nothing is left to administer.
        await assertNotLastAdmin(seeded.organizationId, seeded.userId, { allowWhenSoleMember: true })
      })
    })
  })

  describe('elevated access', () => {
    test('a MEMBER cannot take over another member\'s resource', async () => {
      await withSeeded({ role: 'MEMBER' }, async (seeded: any) => {
        const { withElevatedAccess } = await import('@/lib/server/elevated')
        await assert.rejects(
          () => withElevatedAccess(
            seeded.auth,
            { action: 'admin.resource.read', resourceType: 'flow', resourceId: 'f1' },
            async () => 'reached',
          ),
          (error: any) => error.code === 'FORBIDDEN',
        )
      })
    })

    test('an ADMIN takeover writes an audit row', async () => {
      // The property that matters: reaching another member's work without a
      // trace is not expressible through this API.
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        const { withElevatedAccess } = await import('@/lib/server/elevated')
        const result = await withElevatedAccess(
          seeded.auth,
          { action: 'admin.resource.read', resourceType: 'flow', resourceId: 'flow-123' },
          async () => 'reached',
        )
        assert.equal(result, 'reached')

        // recordAudit is fire-and-forget by design, so poll briefly rather than
        // assuming the write landed synchronously.
        let row: any = null
        for (let attempt = 0; attempt < 20 && !row; attempt++) {
          row = await prisma.auditEvent.findFirst({
            where: { organizationId: seeded.organizationId, action: 'admin.resource.read' },
          })
          if (!row) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.ok(row, 'expected an audit row for the elevated read')
        assert.equal(row.resourceId, 'flow-123')
      })
    })
  })
}
