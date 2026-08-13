/**
 * Mutating a credential SOMEONE ELSE added is elevated, audited access.
 *
 * Credentials are workspace-shared by design: every member can list them
 * (redacted) and attach them to a flow. Sharing the USE of a credential is not
 * the same as sharing the right to silently re-point it at another host or
 * delete it out from under the flows that depend on it — so cross-owner
 * mutation goes through the same resource:takeover gate as any other member's
 * work, and lands in the audit log.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = 'test-encryption-key'

  let prisma: typeof import('@/lib/prisma')['prisma']
  let seeded: { organizationId: string; userId: string; auth: any; cleanup: () => Promise<void> }
  let otherUserId: string
  let installTestAuth: (auth: any) => void

  /** A credential added by a DIFFERENT member of the same workspace. */
  const someoneElsesCredential = async (name: string) =>
    prisma.credential.create({
      data: {
        organizationId: seeded.organizationId,
        userId: otherUserId,
        createdById: otherUserId,
        name,
        type: 'bearer',
        allowedDomains: ['example.com'],
        authConfig: {},
      },
    })

  const asRole = (role: 'ADMIN' | 'MEMBER') => {
    installTestAuth({ ...seeded.auth, role, isAdmin: role === 'ADMIN', actor: { ...seeded.auth.actor, role } })
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    seeded = (await testAuth.seedTestOrg(prisma)) as never
    installTestAuth(seeded.auth)
    const other = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, role: 'MEMBER' },
    })
    otherUserId = other.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('a member cannot delete a credential another member added', async () => {
    const credential = await someoneElsesCredential('takeover-delete-denied')
    asRole('MEMBER')
    const { DELETE } = await import('../credentials/[id]/route')
    const response = await DELETE(new NextRequest(`http://test/api/credentials/${credential.id}`, { method: 'DELETE' }))
    assert.equal(response.status, 403, await response.text())

    const still = await prisma.credential.findFirst({ where: { id: credential.id, organizationId: seeded.organizationId } })
    assert.ok(still, 'the credential must survive a refused delete')
  })

  test('a member cannot re-point another member credential at a different host', async () => {
    const credential = await someoneElsesCredential('takeover-update-denied')
    asRole('MEMBER')
    const { PUT } = await import('../credentials/[id]/route')
    const response = await PUT(
      new NextRequest(`http://test/api/credentials/${credential.id}`, {
        method: 'PUT',
        body: JSON.stringify({ allowedDomains: ['attacker.example'] }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    assert.equal(response.status, 403, await response.text())

    const unchanged = await prisma.credential.findFirst({ where: { id: credential.id, organizationId: seeded.organizationId } })
    assert.deepEqual(unchanged?.allowedDomains, ['example.com'])
  })

  test('a member can still edit a credential they added themselves', async () => {
    const mine = await prisma.credential.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        createdById: seeded.userId,
        name: 'my-own-credential',
        type: 'bearer',
        allowedDomains: ['example.com'],
        authConfig: {},
      },
    })
    asRole('MEMBER')
    const { PUT } = await import('../credentials/[id]/route')
    const response = await PUT(
      new NextRequest(`http://test/api/credentials/${mine.id}`, {
        method: 'PUT',
        body: JSON.stringify({ allowedDomains: ['api.example.com'] }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    assert.equal(response.status, 200, await response.text())
  })

  test('an admin may take over another member credential, and the takeover is audited', async () => {
    const credential = await someoneElsesCredential('takeover-allowed')
    asRole('ADMIN')
    const { PUT } = await import('../credentials/[id]/route')
    const response = await PUT(
      new NextRequest(`http://test/api/credentials/${credential.id}`, {
        method: 'PUT',
        body: JSON.stringify({ allowedDomains: ['api.example.com'] }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    assert.equal(response.status, 200, await response.text())

    const elevated = await prisma.auditEvent.findMany({
      where: { organizationId: seeded.organizationId, action: 'admin.resource.update', resourceId: credential.id },
    })
    assert.equal(elevated.length, 1, 'expected exactly one elevated-access audit row')
    assert.equal((elevated[0].detail as Record<string, unknown>).targetUserId, otherUserId)
  })

  test('any member may still ADD a credential — sharing use is not the risk', async () => {
    asRole('MEMBER')
    const { POST } = await import('../credentials/route')
    const response = await POST(
      new NextRequest('http://test/api/credentials', {
        method: 'POST',
        body: JSON.stringify({
          name: 'member-added',
          type: 'bearer',
          token: 'sk-member',
          allowedDomains: ['example.com'],
        }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    assert.equal(response.status, 200, await response.text())
  })
}
