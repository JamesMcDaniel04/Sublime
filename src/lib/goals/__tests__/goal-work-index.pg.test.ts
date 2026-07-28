/**
 * Proves the partial unique index, which is raw SQL in the migration and
 * therefore invisible to Prisma's types and to every jsdom test. Requires a
 * real Postgres — see the `verify` skill for the throwaway-PG protocol.
 * The whole file is inert without TEST_DATABASE_URL so `npm test` stays green.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let goalId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const goal = await prisma.goal.create({
      data: {
        organizationId: seeded.organizationId,
        name: 'Revive every stalled deal',
        kind: 'kpi',
        unit: 'count',
        direction: 'increase',
        startValue: 0,
        targetValue: 12,
        startAt: new Date('2026-07-01T00:00:00Z'),
        targetDate: new Date('2026-08-01T00:00:00Z'),
        createdByUserId: seeded.userId,
      },
    })
    goalId = goal.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const row = (overrides: Record<string, unknown> = {}) => ({
    organizationId: seeded.organizationId,
    goalId,
    resourceType: 'agent',
    resourceId: 'agent-1',
    subject: 'Acme Corp — deal 412',
    subjectRef: 'deal-412',
    produced: 're-entry email',
    ...overrides,
  })

  test('a subject may have only one PENDING item', async () => {
    await prisma.goalWork.create({ data: row({ subjectRef: 'deal-one-pending' }) })
    await assert.rejects(
      () => prisma.goalWork.create({ data: row({ subjectRef: 'deal-one-pending' }) }),
      /Unique constraint|goal_work_one_pending_per_subject/,
      'a second pending item for the same subject must be rejected',
    )
  })

  test('disposition frees the subject — a deal that stalls twice is drafted twice', async () => {
    const first = await prisma.goalWork.create({ data: row({ subjectRef: 'deal-redraft' }) })
    // updateMany, not update: the tenant guard requires organizationId in the
    // where clause, and `update` needs a unique key it cannot be part of.
    await prisma.goalWork.updateMany({
      where: { id: first.id, organizationId: seeded.organizationId },
      data: { disposition: 'used', dispositionAt: new Date() },
    })
    const second = await prisma.goalWork.create({ data: row({ subjectRef: 'deal-redraft' }) })
    assert.ok(second.id, 'after disposition the subject must be draftable again')
  })

  test('a null subjectRef opts out of dedupe entirely', async () => {
    await prisma.goalWork.create({ data: row({ subjectRef: null }) })
    await prisma.goalWork.create({ data: row({ subjectRef: null }) })
    const count = await prisma.goalWork.count({
      where: { organizationId: seeded.organizationId, goalId, subjectRef: null },
    })
    assert.equal(count, 2)
  })

  test('the index is scoped per goal — the same subject may be pending on two goals', async () => {
    const other = await prisma.goal.create({
      data: {
        organizationId: seeded.organizationId,
        name: 'Second goal',
        kind: 'kpi',
        unit: 'count',
        direction: 'increase',
        startValue: 0,
        targetValue: 5,
        startAt: new Date('2026-07-01T00:00:00Z'),
        targetDate: new Date('2026-08-01T00:00:00Z'),
        createdByUserId: seeded.userId,
      },
    })
    await prisma.goalWork.create({ data: row({ subjectRef: 'deal-shared' }) })
    const onOther = await prisma.goalWork.create({
      data: row({ subjectRef: 'deal-shared', goalId: other.id }),
    })
    assert.ok(onOther.id, 'the same subject on a different goal must be allowed')
  })
}
