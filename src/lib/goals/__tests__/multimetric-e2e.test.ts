/**
 * Multi-metric create → detail → layout PATCH → refresh against the
 * throwaway Postgres. Skipped unless TEST_DATABASE_URL is present.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let goalId = ''
  let primaryId = ''
  let supportingId = ''
  const targetDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)

  const createBody = () => ({
    name: 'Revenue from demos',
    kind: 'revenue',
    direction: 'increase',
    unit: 'usd',
    startValue: 100,
    targetValue: 200,
    targetDate: targetDate.toISOString(),
    recurrence: null,
    personal: false,
    metrics: [
      {
        source: 'manual',
        metricKey: 'manual.value',
        label: 'Closed revenue',
        role: 'primary',
        config: {},
      },
      {
        source: 'manual',
        metricKey: 'manual.value',
        label: 'Demos booked',
        role: 'supporting',
        unit: 'count',
        config: {},
      },
    ],
    dashboardLayout: {
      version: 1,
      widgets: [
        { id: 'w1', type: 'kpi', config: { metric: 0 } },
        {
          id: 'w2',
          type: 'ratio',
          config: {
            numerator: 0,
            denominator: 1,
            format: 'percent',
          },
        },
      ],
    },
  })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import(
      '@/lib/server/__tests__/test-auth'
    )
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('creates all metrics, resolves draft refs, and baselines only primary', async () => {
    const { POST } = await import('@/app/api/goals/route')
    const response = await POST(
      new NextRequest('http://test/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody()),
      }),
    )
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json()
    goalId = body.goal.id

    const goal = await prisma.goal.findFirst({
      where: { id: goalId, organizationId: seeded.organizationId },
      include: {
        metrics: {
          orderBy: { createdAt: 'asc' },
          include: { datapoints: true },
        },
      },
    })
    assert.equal(goal.metrics.length, 2)
    assert.equal(
      goal.metrics.filter((metric: any) => metric.role === 'primary')
        .length,
      1,
    )
    const primary = goal.metrics.find(
      (metric: any) => metric.role === 'primary',
    )
    const supporting = goal.metrics.find(
      (metric: any) => metric.role === 'supporting',
    )
    primaryId = primary.id
    supportingId = supporting.id
    assert.equal(primary.datapoints.length, 1)
    assert.equal(supporting.datapoints.length, 0)
    assert.equal(
      goal.dashboardLayout.widgets[1].config.numeratorId,
      primary.id,
    )
  })

  test('rejects duplicate primary metrics', async () => {
    const payload = createBody()
    payload.metrics[1].role = 'primary'
    const { POST } = await import('@/app/api/goals/route')
    const response = await POST(
      new NextRequest('http://test/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
    assert.equal(response.status, 400, await response.clone().text())
    assert.match(await response.text(), /Exactly one metric must be primary/)
  })

  test('detail returns every series and layout PATCH enforces ownership', async () => {
    const detailRoute = await import('@/app/api/goals/[id]/route')
    const get = () =>
      detailRoute.GET(
        new NextRequest(`http://test/api/goals/${goalId}`),
      )
    const initial = await get()
    assert.equal(initial.status, 200, await initial.clone().text())
    const initialBody = await initial.json()
    assert.equal(initialBody.goal.metrics.length, 2)
    assert.equal(initialBody.goal.metric.id, primaryId)
    const { parseDashboardLayout } = await import('../dashboard')
    const layout = parseDashboardLayout(initialBody.goal.dashboardLayout)
    assert.ok(layout)

    const reordered = {
      version: 1,
      widgets: [...layout.widgets].reverse(),
    }
    const patched = await detailRoute.PATCH(
      new NextRequest(`http://test/api/goals/${goalId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dashboardLayout: reordered }),
      }),
    )
    assert.equal(patched.status, 200, await patched.clone().text())
    const afterPatch = await get()
    const afterBody = await afterPatch.json()
    assert.deepEqual(
      afterBody.goal.dashboardLayout.widgets.map(
        (widget: { id: string }) => widget.id,
      ),
      ['w2', 'w1'],
    )

    const foreign = await detailRoute.PATCH(
      new NextRequest(`http://test/api/goals/${goalId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dashboardLayout: {
            version: 1,
            widgets: [
              {
                id: 'foreign',
                type: 'kpi',
                config: { metricId: 'not-ours' },
              },
            ],
          },
        }),
      }),
    )
    assert.equal(foreign.status, 400, await foreign.clone().text())
    assert.match(await foreign.text(), /INVALID_LAYOUT/)
  })

  test('evaluation ignores an off-track supporting series', async () => {
    const goal = await prisma.goal.findFirst({
      where: { id: goalId, organizationId: seeded.organizationId },
      select: { startAt: true, targetDate: true },
    })
    const midpoint = new Date(
      (goal.startAt.getTime() + goal.targetDate.getTime()) / 2,
    )
    const bucketKey = midpoint.toISOString().slice(0, 10)
    await prisma.metricDatapoint.createMany({
      data: [
        {
          organizationId: seeded.organizationId,
          goalMetricId: primaryId,
          value: 155,
          capturedAt: midpoint,
          bucketKey,
          origin: 'manual',
        },
        {
          organizationId: seeded.organizationId,
          goalMetricId: supportingId,
          value: -100,
          capturedAt: midpoint,
          bucketKey,
          origin: 'manual',
        },
      ],
    })
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(
      goalId,
      seeded.organizationId,
      midpoint,
    )
    const evaluated = await prisma.goal.findFirst({
      where: { id: goalId, organizationId: seeded.organizationId },
      select: { riskLevel: true },
    })
    assert.equal(evaluated.riskLevel, 'on_track')
  })

  test('legacy single-metric shape remains primary by default', async () => {
    const { POST } = await import('@/app/api/goals/route')
    const response = await POST(
      new NextRequest('http://test/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Legacy goal',
          kind: 'custom_kpi',
          direction: 'increase',
          unit: 'count',
          startValue: 0,
          targetValue: 1,
          targetDate: targetDate.toISOString(),
          recurrence: null,
          personal: true,
          metric: {
            source: 'manual',
            metricKey: 'manual.value',
            config: {},
          },
        }),
      }),
    )
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json()
    const metrics = await prisma.goalMetric.findMany({
      where: {
        organizationId: seeded.organizationId,
        goalId: body.goal.id,
      },
    })
    assert.equal(metrics.length, 1)
    assert.equal(metrics[0].role, 'primary')
  })
}
