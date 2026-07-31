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

    /**
     * Member management wrote ONE action — organization.member.updated — for
     * both "made someone an admin" and "suspended someone". During an incident
     * those are different questions, and an audit log that cannot tell them
     * apart forces a reviewer back to guesswork over timestamps.
     */
    const auditActionsFor = async (organizationId: string, resourceId: string) => {
      // recordAudit is fire-and-forget; poll rather than assume it landed.
      for (let attempt = 0; attempt < 20; attempt++) {
        const rows = await prisma.auditEvent.findMany({
          where: { organizationId, resourceId },
          select: { action: true },
        })
        if (rows.length) return rows.map((row: any) => row.action).sort()
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return []
    }

    test('promoting a member is audited as a role change, not a generic update', async () => {
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        const member = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, role: 'MEMBER' },
        })
        const { PATCH } = await import('../settings/members/route')
        const response = await PATCH(jsonReq('/api/settings/members', 'PATCH', { userId: member.id, role: 'ADMIN' }))
        assert.equal(response.status, 200, await response.text())

        assert.deepEqual(await auditActionsFor(seeded.organizationId, member.id), ['organization.member.role_changed'])
      })
    })

    test('a suspension is logged even when session teardown fails', async () => {
      // Suspending calls Supabase admin.signOut, which needs a service-role key
      // this harness does not have — so the request fails here. That is exactly
      // the case worth pinning: the database change has already committed, so
      // the audit row must not depend on an external call that can fail. It
      // used to, and an unreachable Supabase silently produced a deactivated
      // member with nothing in the log.
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        const member = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, role: 'MEMBER' },
        })
        const { PATCH } = await import('../settings/members/route')
        await PATCH(jsonReq('/api/settings/members', 'PATCH', { userId: member.id, isActive: false }))

        const suspended = await prisma.user.findFirst({ where: { id: member.id, organizationId: seeded.organizationId } })
        assert.equal(suspended.isActive, false, 'the member was in fact deactivated')
        assert.deepEqual(await auditActionsFor(seeded.organizationId, member.id), ['organization.member.deactivated'])
      })
    })

    test('revoking an invitation is audited, like issuing one', async () => {
      // Granting access was logged; withdrawing it was not. An audit log that
      // records only the grants tells a reviewer someone was invited and never
      // that the invitation was pulled — the two halves have to match.
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        // Created directly: the invite ROUTE calls Supabase's admin API, which
        // has no service-role key here. The revoke path is what is under test.
        const invitation = await prisma.organizationInvitation.create({
          data: {
            organizationId: seeded.organizationId,
            email: `revoke-${crypto.randomUUID()}@example.com`,
            role: 'MEMBER',
            invitedById: seeded.auth.dbUser.id,
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
          },
        })

        const { DELETE } = await import('../settings/members/route')
        const response = await DELETE(req(`/api/settings/members?invitationId=${invitation.id}`, { method: 'DELETE' }))
        assert.equal(response.status, 200, await response.text())

        const revoked = await prisma.organizationInvitation.findFirst({
          where: { id: invitation.id, organizationId: seeded.organizationId },
        })
        assert.ok(revoked.revokedAt, 'the invitation should be revoked')
        assert.deepEqual(
          await auditActionsFor(seeded.organizationId, invitation.id),
          ['organization.member.invite_revoked'],
        )
      })
    })

    test('one request that changes role AND activity records both facts', async () => {
      // Collapsing these into a single row would lose one of the two changes.
      await withSeeded({ role: 'ADMIN' }, async (seeded: any) => {
        const member = await prisma.user.create({
          data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: false, role: 'MEMBER' },
        })
        const { PATCH } = await import('../settings/members/route')
        const response = await PATCH(jsonReq('/api/settings/members', 'PATCH', { userId: member.id, role: 'ADMIN', isActive: true }))
        assert.equal(response.status, 200, await response.text())

        assert.deepEqual(
          await auditActionsFor(seeded.organizationId, member.id),
          ['organization.member.reactivated', 'organization.member.role_changed'],
        )
      })
    })
  })

  describe('billing hard-stop', () => {
    test('an unpaid workspace cannot fire an agent through its trigger webhook', async () => {
      await withSeeded({ role: 'ADMIN', plan: 'TRIAL' as never }, async (seeded: any) => {
        const secret = 'trigger-secret-test'
        const { hashToken } = await import('@/lib/crypto/secrets')
        const agent = await prisma.agentTask.create({
          data: {
            organizationId: seeded.organizationId,
            userId: seeded.userId,
            description: 'billing gate probe',
            objective: 'noop',
            status: 'ACTIVE',
            metadata: { triggerSecretHash: hashToken(secret) },
          },
        })
        const { POST } = await import('../agents/[id]/trigger/route')
        const response = await POST(req(`/api/agents/${agent.id}/trigger`, {
          method: 'POST',
          headers: { 'x-trigger-secret': secret, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }))
        assert.equal(response.status, 402, await response.text())
      })
    })
  })
}
