/**
 * End-to-end goal refresh/evaluation drive against the throwaway Postgres.
 * Skipped unless TEST_DATABASE_URL is present.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

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

  test('provisioning an accepted goal action is born attributed', async () => {
    const template = await prisma.agentTemplate.create({
      data: {
        name: 'Goal recovery helper',
        description: 'Prepare a weekly recovery brief.',
        type: 'agent',
        userId: seeded.userId,
        organizationId: seeded.organizationId,
        configuration: {
          kind: 'agent',
          instructions: 'Prepare a weekly recovery brief grounded in the available evidence.',
          integrations: [],
          requiredIntegrations: [],
          departments: ['sales'],
        },
      },
    })
    const suggestion = await prisma.userSuggestion.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        kind: 'goal_action',
        title: 'Recover the goal',
        description: 'Deploy the recovery helper.',
        targetType: 'goal',
        targetId: goalId,
        metadata: { goalId, seedKey: null },
      },
    })
    const request = new NextRequest('http://test/api/templates/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: template.id,
        targetKind: 'agent',
        goalId,
        suggestionId: suggestion.id,
      }),
    })
    const response = await (await import('@/app/api/templates/provision/route')).POST(request)
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json()
    assert.equal(body.kind, 'agent')

    const contribution = await prisma.goalContribution.findFirst({
      where: {
        organizationId: seeded.organizationId,
        goalId,
        resourceType: 'agent',
        resourceId: body.agentId,
      },
    })
    assert.equal(contribution?.origin, 'suggestion')
    const accepted = await prisma.userSuggestion.findFirst({
      where: { id: suggestion.id, organizationId: seeded.organizationId },
    })
    assert.equal(accepted?.status, 'accepted')
  })

  test('recurring goal catches up elapsed windows without duplicate periods', async () => {
    const recurring = await prisma.goal.create({
      data: {
        organizationId: seeded.organizationId,
        name: 'Quarterly quota',
        kind: 'quota',
        direction: 'increase',
        unit: 'usd',
        startValue: 100,
        targetValue: 150,
        startAt: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-04-01T00:00:00Z'),
        recurrence: 'quarterly',
        createdByUserId: seeded.userId,
        metrics: {
          create: {
            organizationId: seeded.organizationId,
            source: 'manual',
            metricKey: 'manual.value',
            datapoints: {
              create: {
                organizationId: seeded.organizationId,
                value: 120,
                capturedAt: new Date('2026-03-31T00:00:00Z'),
                bucketKey: '2026-03-31',
                origin: 'manual',
              },
            },
          },
        },
      },
    })
    const catchupNow = new Date('2026-09-01T00:00:00Z')
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(recurring.id, seeded.organizationId, catchupNow)

    const advanced = await prisma.goal.findFirst({
      where: { id: recurring.id, organizationId: seeded.organizationId },
    })
    assert.equal(advanced.status, 'active')
    assert.equal(advanced.startValue, 120)
    assert.equal(advanced.startAt.toISOString(), '2026-07-01T00:00:00.000Z')
    assert.equal(advanced.targetDate.toISOString(), '2026-10-01T00:00:00.000Z')
    const periods = await prisma.goalPeriod.findMany({
      where: { organizationId: seeded.organizationId, goalId: recurring.id },
      orderBy: { periodEnd: 'asc' },
    })
    assert.equal(periods.length, 2)
    assert.deepEqual(periods.map((period: any) => period.outcome), ['missed', 'missed'])
    assert.deepEqual(periods.map((period: any) => period.finalValue), [120, 120])

    await evaluateAndPersistGoal(recurring.id, seeded.organizationId, catchupNow)
    assert.equal(
      await prisma.goalPeriod.count({
        where: { organizationId: seeded.organizationId, goalId: recurring.id },
      }),
      2,
    )
  })

  test('weekly digest claim prevents a retry from double-sending', async () => {
    const digestNow = new Date('2026-07-27T14:05:00Z')
    const { sendWeeklyGoalDigests } = await import('../digest')
    const before = await prisma.notification.count({
      where: { organizationId: seeded.organizationId, type: 'goal.digest' },
    })
    const first = await sendWeeklyGoalDigests(digestNow)
    const second = await sendWeeklyGoalDigests(digestNow)
    assert.equal(first.sent, 1)
    assert.equal(second.sent, 0)
    assert.equal(
      await prisma.notification.count({
        where: { organizationId: seeded.organizationId, type: 'goal.digest' },
      }),
      before + 1,
    )
  })
} else {
  test('goals e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
