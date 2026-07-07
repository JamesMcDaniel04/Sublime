import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('auth gate (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let assertEntitled: any
  let entitlementGateEnabled: any
  let AuthContextError: any
  const ids: { entitled?: string; unentitled?: string; user?: string } = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ assertEntitled, entitlementGateEnabled, AuthContextError } = await import('../auth'))

    const entitled = await prisma.organization.create({
      data: { name: 'E', slug: `e-${Date.now()}`, peopleAiTeamId: `t-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: entitled.id },
    })
    await prisma.peopleAiConnection.create({
      data: {
        organizationId: entitled.id,
        userId: user.id,
        membershipId: 'm-1',
        teamId: entitled.peopleAiTeamId,
        accessToken: 'enc',
        status: 'active',
      },
    })
    const unentitled = await prisma.organization.create({ data: { name: 'U', slug: `u-${Date.now()}` } })
    ids.entitled = entitled.id
    ids.unentitled = unentitled.id
    ids.user = user.id
  })

  after(async () => {
    await prisma.peopleAiConnection.deleteMany({ where: { organizationId: ids.entitled } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
    await prisma.organization.deleteMany({ where: { id: { in: [ids.entitled!, ids.unentitled!] } } })
    await prisma.$disconnect()
  })

  test('entitled org passes the gate', async () => {
    await assert.doesNotReject(assertEntitled(ids.entitled!))
  })

  test('unentitled org is rejected with ENTITLEMENT_REQUIRED', async () => {
    await assert.rejects(assertEntitled(ids.unentitled!), (error: any) => {
      assert.ok(error instanceof AuthContextError)
      assert.equal(error.status, 403)
      assert.equal(error.code, 'ENTITLEMENT_REQUIRED')
      return true
    })
  })

  test('gate defaults: on in production, off in development, flag overrides', () => {
    const original = { ...process.env }
    Object.assign(process.env, { NODE_ENV: 'production' })
    delete process.env.ENTITLEMENT_GATE
    assert.equal(entitlementGateEnabled(), true)
    Object.assign(process.env, { NODE_ENV: 'development' })
    assert.equal(entitlementGateEnabled(), false)
    process.env.ENTITLEMENT_GATE = 'on'
    assert.equal(entitlementGateEnabled(), true)
    Object.assign(process.env, { NODE_ENV: 'production' })
    process.env.ENTITLEMENT_GATE = 'off'
    assert.equal(entitlementGateEnabled(), false)
    process.env = original
  })
}
