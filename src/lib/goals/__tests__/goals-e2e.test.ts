/**
 * End-to-end goal refresh/evaluation drive against the throwaway Postgres.
 * Skipped unless TEST_DATABASE_URL is present.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
  let contributionId: string
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
    contributionId = contribution.id
    const accepted = await prisma.userSuggestion.findFirst({
      where: { id: suggestion.id, organizationId: seeded.organizationId },
    })
    assert.equal(accepted?.status, 'accepted')
  })

  test('contribution estimate edit persists and records provenance-safe behavior', async () => {
    const request = new NextRequest(
      `http://test/api/goals/${goalId}/contributions`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contributionId,
          estimatedMinutesSavedPerRun: 45,
        }),
      },
    )
    const response = await (
      await import('@/app/api/goals/[id]/contributions/route')
    ).PATCH(request)
    assert.equal(response.status, 200, await response.clone().text())
    const contribution = await prisma.goalContribution.findFirst({
      where: { id: contributionId, organizationId: seeded.organizationId },
    })
    assert.equal(contribution.estimatedMinutesSavedPerRun, 45)
    assert.equal(
      await prisma.userEvent.count({
        where: {
          organizationId: seeded.organizationId,
          kind: 'goal_estimate_edited',
          resourceId: contribution.resourceId,
        },
      }),
      1,
    )
  })

  test('estimate calibration requires edits from three distinct organizations', async () => {
    const orgIds: string[] = []
    const seedKey = 'sales-new-lead-to-sf-opportunity'
    try {
      for (const [index, estimate] of [40, 50, 60].entries()) {
        const org = await prisma.organization.create({
          data: { name: `Calibration ${index}`, slug: `cal-${crypto.randomUUID()}` },
        })
        orgIds.push(org.id)
        const goal = await prisma.goal.create({
          data: {
            organizationId: org.id,
            name: 'Calibration goal',
            kind: 'arr',
            startValue: 1,
            targetValue: 2,
            targetDate: new Date('2027-01-01T00:00:00Z'),
          },
        })
        await prisma.goalContribution.create({
          data: {
            organizationId: org.id,
            goalId: goal.id,
            resourceType: 'flow',
            resourceId: `flow-${index}`,
            origin: 'suggestion',
            seedKey,
            estimatedMinutesSavedPerRun: estimate,
            // Provenance: only human-edited rows feed calibration.
            estimateEdited: true,
          },
        })
      }
      const { calibrateTemplateEstimates } = await import('../calibrate-estimates')
      await calibrateTemplateEstimates()
      const calibration = await prisma.templateEstimateCalibration.findUnique({
        where: { seedKey },
      })
      assert.equal(calibration?.orgCount, 3)
      assert.equal(calibration?.medianMinutes, 50)
    } finally {
      await Promise.all(
        orgIds.map((id) => prisma.organization.delete({ where: { id } }).catch(() => null)),
      )
      await prisma.templateEstimateCalibration.deleteMany({ where: { seedKey } })
    }
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
    // sendWeeklyGoalDigests is a GLOBAL sweep, so any other test file that
    // seeded an org with an active goal also gets a send. What this test owns is
    // the claim: the second sweep must send nothing, and this org's own
    // notification count must rise by exactly one.
    assert.ok(first.sent >= 1, `expected at least this org's digest, got ${first.sent}`)
    assert.equal(second.sent, 0, 'the weekly claim must block the retry')
    assert.equal(
      await prisma.notification.count({
        where: { organizationId: seeded.organizationId, type: 'goal.digest' },
      }),
      before + 1,
    )
  })

  test('Postgres metric reads a real scalar through the credential vault', async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'goals-e2e-key'
    const { buildCredentialConfig } = await import('@/lib/credentials/config')
    const credential = await prisma.credential.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        name: 'QA Postgres',
        type: 'bearer',
        authConfig: buildCredentialConfig({ type: 'bearer', token: TEST_DB }),
        createdById: seeded.userId,
      },
    })
    const { postgresMetricSource } = await import('@/lib/metrics/sources/postgres')
    const reading = await postgresMetricSource.fetchValue(
      {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        connectionRef: `credential:${credential.id}`,
        config: { query: 'SELECT 42' },
      },
      'postgres.query',
    )
    assert.equal(reading.value, 42)
  })

  test('benchmark surfaces at five organizations and stays hidden at four', async () => {
    const peerOrgIds: string[] = []
    try {
      // Baseline BEFORE seeding peers. This test used to rely on 'mrr' being a
      // kind nothing else in the database used; with only three kinds
      // (spec 2026-07-28) this org's own settled 'arr' goals land in the same
      // benchmark row, so isolation has to be measured rather than assumed.
      const { aggregateGoalBenchmarks: baselineSweep } = await import(
        '../aggregate-benchmarks'
      )
      await baselineSweep()
      // GoalBenchmark is a global model with no organizationId, like
      // PlatformArchetype — the tenant guard does not apply.
      const baselineArr = await prisma.goalBenchmark.findUnique({
        where: { kind: 'arr' },
      })
      const baseArrOrgs = baselineArr?.orgCount ?? 0
      for (let index = 0; index < 5; index += 1) {
        const org = await prisma.organization.create({
          data: { name: `MRR peer ${index}`, slug: `mrr-peer-${crypto.randomUUID()}` },
        })
        peerOrgIds.push(org.id)
        await prisma.goal.create({
          data: {
            organizationId: org.id,
            name: 'Settled MRR',
            kind: 'arr',
            startValue: 10,
            targetValue: 20,
            targetDate: new Date('2026-06-01T00:00:00Z'),
            status: index < 3 ? 'achieved' : 'missed',
          },
        })
      }
      for (let index = 0; index < 4; index += 1) {
        const org = await prisma.organization.create({
          data: { name: `Lead-gen peer ${index}`, slug: `lead-gen-peer-${crypto.randomUUID()}` },
        })
        peerOrgIds.push(org.id)
        await prisma.goal.create({
          data: {
            organizationId: org.id,
            name: 'Settled CARR',
            kind: 'kpi',
            startValue: 10,
            targetValue: 20,
            targetDate: new Date('2026-06-01T00:00:00Z'),
            status: 'achieved',
          },
        })
      }
      const target = async (kind: 'arr' | 'kpi') =>
        prisma.goal.create({
          data: {
            organizationId: seeded.organizationId,
            name: `${kind.toUpperCase()} target`,
            kind,
            startValue: 10,
            targetValue: 20,
            targetDate: new Date('2027-01-01T00:00:00Z'),
            createdByUserId: seeded.userId,
          },
        })
      const [mrrTarget, leadGenTarget] = await Promise.all([target('arr'), target('kpi')])
      const { aggregateGoalBenchmarks } = await import('../aggregate-benchmarks')
      await aggregateGoalBenchmarks()
      const route = await import('@/app/api/goals/[id]/route')
      const [mrrResponse, leadGenResponse] = await Promise.all([
        route.GET(new NextRequest(`http://test/api/goals/${mrrTarget.id}`)),
        route.GET(new NextRequest(`http://test/api/goals/${leadGenTarget.id}`)),
      ])
      const [mrrBody, leadGenBody] = await Promise.all([
        mrrResponse.json(),
        leadGenResponse.json(),
      ])
      // Exact delta: the five peers must all be counted.
      assert.equal(mrrBody.goal.benchmark.orgCount, baseArrOrgs + 5)
      // The rate is a ratio over every settled 'arr' outcome in the database,
      // which now includes this org's own goals, so only its shape can be
      // asserted here. surfaceGoalBenchmark's rate math is covered exactly by
      // aggregate-benchmarks.test.ts.
      const rate = mrrBody.goal.benchmark.achievedRate
      assert.ok(Number.isInteger(rate) && rate >= 0 && rate <= 100, `rate ${rate}`)

      // The four-peer kind stays hidden. State the precondition rather than
      // assuming it: if something else had pushed 'kpi' over the floor, a null
      // assertion would be passing for the wrong reason.
      const kpiRow = await prisma.goalBenchmark.findUnique({ where: { kind: 'kpi' } })
      assert.ok(
        (kpiRow?.orgCount ?? 0) < 5,
        `precondition: kpi must be below the floor, saw ${kpiRow?.orgCount}`,
      )
      assert.equal(leadGenBody.goal.benchmark, null)
    } finally {
      await Promise.all(
        peerOrgIds.map((id) => prisma.organization.delete({ where: { id } }).catch(() => null)),
      )
    }
  })

  test('ROI report route streams non-empty PDF bytes', async () => {
    const response = await (
      await import('@/app/api/goals/report/route')
    ).GET(new NextRequest('http://test/api/goals/report?months=3'))
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.length > 1_000)
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF')
  })
} else {
  test('goals e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
