import crypto from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { User } from '@supabase/supabase-js'

const TEST_DB = process.env.TEST_DATABASE_URL

if (!TEST_DB) {
  test('auth provisioning (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
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
      user_metadata: { full_name: 'New User', organization_name: 'New Workspace' },
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

  test('a new authenticated user always receives an organization', async () => {
    Object.assign(process.env, { NODE_ENV: 'production' })
    delete process.env.AUTH_ALLOW_JIT_PROVISIONING

    const user = identity()
    const created = await provisionUser(user)

    assert.ok(created?.organizationId)
    organizationIds.push(created.organizationId)
    assert.equal(created.supabaseId, user.id)
    assert.equal(created.role, 'ADMIN')
    assert.equal(created.organization?.name, 'New Workspace')
  })

  test('a pending invitation joins its organization instead of creating another', async () => {
    const organization = await systemPrisma.organization.create({
      data: { name: 'Invited Workspace', slug: `invite-${crypto.randomUUID()}` },
    })
    organizationIds.push(organization.id)
    const user = identity({ email: `invited-${crypto.randomUUID()}@example.com` })
    const invitation = await systemPrisma.organizationInvitation.create({
      data: {
        organizationId: organization.id,
        email: user.email!,
        role: 'USER',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    const created = await provisionUser(user)
    const accepted = await systemPrisma.organizationInvitation.findUnique({ where: { id: invitation.id } })

    assert.equal(created?.organizationId, organization.id)
    assert.equal(created?.role, 'USER')
    assert.ok(accepted?.acceptedAt)
  })
}
