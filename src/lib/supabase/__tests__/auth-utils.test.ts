import crypto from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { User } from '@supabase/supabase-js'

const TEST_DB = process.env.TEST_DATABASE_URL

if (!TEST_DB) {
  test('workspace assignment (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let systemPrisma: typeof import('@/lib/prisma')['systemPrisma']
  let provisionUser: typeof import('../auth-utils')['provisionUser']
  const organizationIds: string[] = []

  function identity(overrides: Partial<User> = {}): User {
    return {
      id: crypto.randomUUID(),
      email: `signup-${crypto.randomUUID()}@example.com`,
      user_metadata: { full_name: 'New User' },
      app_metadata: {},
      aud: 'authenticated',
      created_at: new Date().toISOString(),
      ...overrides,
    } as User
  }

  before(async () => {
    ;({ systemPrisma } = await import('@/lib/prisma'))
    ;({ provisionUser } = await import('../auth-utils'))
  })

  after(async () => {
    for (const id of organizationIds) {
      await systemPrisma.organization.deleteMany({ where: { id } }).catch(() => {})
    }
  })

  test('a new signup gets its OWN workspace as admin — never an existing one', async () => {
    // An older admin workspace exists; the new signup must NOT be folded into it.
    const original = await systemPrisma.organization.create({
      data: {
        name: 'Original Workspace',
        slug: `original-${crypto.randomUUID()}`,
        createdAt: new Date(0),
      },
    })
    organizationIds.push(original.id)
    await systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `owner-${crypto.randomUUID()}@example.com`,
        role: 'ADMIN',
        organizationId: original.id,
      },
    })

    const signup = identity()
    const member = await provisionUser(signup)
    if (member.organizationId) organizationIds.push(member.organizationId)

    assert.ok(member.organizationId)
    assert.notEqual(member.organizationId, original.id)
    assert.equal(member.role, 'ADMIN')
    assert.equal(member.supabaseId, signup.id)
  })

  test('provisioning is idempotent — a second call keeps the same workspace', async () => {
    const signup = identity()
    const first = await provisionUser(signup)
    if (first.organizationId) organizationIds.push(first.organizationId)
    const second = await provisionUser(signup)

    assert.equal(second.organizationId, first.organizationId)
    assert.equal(second.id, first.id)
  })

  test('a pending invitation overrides automatic original-workspace assignment', async () => {
    const invited = await systemPrisma.organization.create({
      data: { name: 'Invited Workspace', slug: `invited-${crypto.randomUUID()}` },
    })
    organizationIds.push(invited.id)
    const signup = identity()
    const invitation = await systemPrisma.organizationInvitation.create({
      data: {
        organizationId: invited.id,
        email: signup.email!,
        role: 'ADMIN',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    const member = await provisionUser(signup)
    const accepted = await systemPrisma.organizationInvitation.findUnique({ where: { id: invitation.id } })

    assert.equal(member.organizationId, invited.id)
    assert.equal(member.role, 'ADMIN')
    assert.ok(accepted?.acceptedAt)
  })
}
