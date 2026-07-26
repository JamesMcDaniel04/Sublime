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
} else {
  test('goals e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
