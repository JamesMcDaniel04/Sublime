/**
 * End-to-end goal refresh/evaluation drive against the throwaway Postgres.
 * Skipped unless TEST_DATABASE_URL is present.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const DAY = 24 * 60 * 60 * 1000
  let prisma: any
  let seeded: any
  let goalId: string
  let metricId: string
  let now: Date

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    now = new Date('2026-07-25T12:00:00Z')
    const goal = await prisma.goal.create({
      data: {
        organizationId: seeded.organizationId,
        name: 'Double ARR',
        kind: 'arr',
        direction: 'increase',
        unit: 'usd',
        startValue: 100,
        targetValue: 200,
        startAt: new Date(now.getTime() - 50 * DAY),
        targetDate: new Date(now.getTime() + 50 * DAY),
        createdByUserId: seeded.userId,
        metrics: {
          create: {
            organizationId: seeded.organizationId,
            source: 'stripe',
            metricKey: 'stripe.arr',
            connectionRef: 'credential:test',
            refreshIntervalHours: 24,
          },
        },
      },
      include: { metrics: true },
    })
    goalId = goal.id
    metricId = goal.metrics[0].id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('refresh persists readings and emits only on a worsening transition', async () => {
    const { refreshGoalMetrics } = await import('../refresh')
    const first = await refreshGoalMetrics(now, {
      fetchReading: async () => ({ value: 120, asOf: now }),
    })
    assert.equal(first.refreshed, 1)

    const point = await prisma.metricDatapoint.findFirst({
      where: { organizationId: seeded.organizationId, goalMetricId: metricId },
    })
    assert.equal(point.value, 120)
    const offTrack = await prisma.goal.findFirst({
      where: { id: goalId, organizationId: seeded.organizationId },
    })
    assert.equal(offTrack.riskLevel, 'off_track')
    assert.equal(
      await prisma.userSuggestion.count({
        where: {
          organizationId: seeded.organizationId,
          kind: 'goal_action',
          targetId: goalId,
          status: 'open',
        },
      }),
      1,
    )

    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000)
    await refreshGoalMetrics(later, {
      fetchReading: async () => ({ value: 120, asOf: later }),
    })
    assert.equal(
      await prisma.userSuggestion.count({
        where: {
          organizationId: seeded.organizationId,
          kind: 'goal_action',
          targetId: goalId,
          status: 'open',
        },
      }),
      1,
    )

    const recoveredAt = new Date(now.getTime() + 50 * 60 * 60 * 1000)
    await refreshGoalMetrics(recoveredAt, {
      fetchReading: async () => ({ value: 190, asOf: recoveredAt }),
    })
    const recovered = await prisma.goal.findFirst({
      where: { id: goalId, organizationId: seeded.organizationId },
    })
    assert.equal(recovered.riskLevel, 'on_track')
  })
} else {
  test('goals e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
