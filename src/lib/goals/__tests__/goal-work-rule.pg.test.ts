/**
 * The one-active-rule-per-scope partial index is raw SQL in the migration and
 * invisible to Prisma's types. Requires real Postgres — see the `verify`
 * skill. Inert without TEST_DATABASE_URL so `npm test` stays green.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const rule = (overrides: Record<string, unknown> = {}) => ({
    organizationId: seeded.organizationId,
    goalId: 'goal-1',
    resourceId: 'agent-1',
    signal: 'daysCold',
    statement: 'Do not work subjects whose daysCold is under 14.',
    skippedCount: 6,
    totalCount: 7,
    ...overrides,
  })

  test('a scope may hold only one ACTIVE rule per signal', async () => {
    await prisma.goalWorkRule.create({ data: rule() })
    await assert.rejects(
      () => prisma.goalWorkRule.create({ data: rule() }),
      /Unique constraint|one_active_per_scope/,
      'a second active rule for the same signal and scope must be rejected',
    )
  })

  test('retiring frees the scope so the lesson can be relearned', async () => {
    const first = await prisma.goalWorkRule.create({ data: rule({ signal: 'stage' }) })
    await prisma.goalWorkRule.updateMany({
      where: { id: first.id, organizationId: seeded.organizationId },
      data: { status: 'retired', retiredAt: new Date(), retiredReason: 'probes_contradicted' },
    })
    const second = await prisma.goalWorkRule.create({ data: rule({ signal: 'stage' }) })
    assert.ok(second.id, 'after retirement the signal is learnable again')
  })

  test('a seed-level rule does not collide with a goal-level rule', async () => {
    // COALESCE in the index means null scope columns compare as '' — the two
    // levels must still be distinguishable.
    await prisma.goalWorkRule.create({ data: rule({ signal: 'contacts' }) })
    const seedLevel = await prisma.goalWorkRule.create({
      data: rule({
        signal: 'contacts',
        goalId: null,
        resourceId: null,
        seedKey: 'sales-sequence-personalizer',
      }),
    })
    assert.ok(seedLevel.id, 'level 1 and level 2 rules coexist')
  })

  test('two different orgs may each hold the same rule', async () => {
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const other = await seedTestOrg(prisma)
    const theirs = await prisma.goalWorkRule.create({
      data: rule({ organizationId: other.organizationId, signal: 'daysCold' }),
    })
    assert.ok(theirs.id, 'the index is org-scoped')
    await other.cleanup()
    const { installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    installTestAuth(seeded.auth)
  })
}
