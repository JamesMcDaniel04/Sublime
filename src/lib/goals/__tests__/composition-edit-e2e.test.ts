/**
 * Binding drivers on an EXISTING goal through PUT /api/goals/[id]/components.
 * Skipped unless TEST_DATABASE_URL is present.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const DAY = 24 * 60 * 60 * 1000
  const SLOTS = ['new_arr', 'expansion_arr', 'contraction_arr', 'churned_arr']
  let prisma: any
  let seeded: any
  let organizationId = ''
  let goalId = ''

  const put = async (body: unknown) => {
    const route = await import('@/app/api/goals/[id]/components/route')
    return route.PUT(
      new NextRequest(`http://test/api/goals/${goalId}/components`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  const driver = (slot: string) => ({
    slot,
    label: slot,
    source: 'manual',
    metricKey: 'manual.value',
    config: {},
  })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import(
      '@/lib/server/__tests__/test-auth'
    )
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId

    // An UNCOMPOSED ARR goal — the case that had no path to a composition
    // before this endpoint existed.
    const goal = await prisma.goal.create({
      data: {
        organizationId,
        name: 'Legacy ARR goal',
        kind: 'arr',
        direction: 'increase',
        unit: 'usd',
        startValue: 2_000_000,
        targetValue: 3_000_000,
        startAt: new Date(Date.now() - 50 * DAY),
        targetDate: new Date(Date.now() + 50 * DAY),
        createdByUserId: seeded.userId,
      },
    })
    goalId = goal.id
    const primary = await prisma.goalMetric.create({
      data: {
        organizationId,
        goalId,
        role: 'primary',
        source: 'manual',
        metricKey: 'manual.value',
        config: {},
      },
    })
    const now = new Date()
    await prisma.metricDatapoint.create({
      data: {
        organizationId,
        goalMetricId: primary.id,
        value: 2_500_000,
        capturedAt: now,
        bucketKey: now.toISOString().slice(0, 10),
        origin: 'manual',
      },
    })
  })

  after(async () => {
    await prisma.$disconnect()
  })

  test('binds a composition onto a goal that had none', async () => {
    const response = await put({
      composition: { kind: 'arr' },
      components: SLOTS.map(driver),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    const metrics = await prisma.goalMetric.findMany({
      where: { organizationId, goalId, role: 'component' },
      select: { slot: true },
    })
    assert.deepEqual(metrics.map((m: any) => m.slot).sort(), [...SLOTS].sort())

    // Re-evaluated in the same request, so the strip is never stale.
    assert.ok(body.compositionState, 'compositionState returned')
    assert.equal(body.compositionState.level, 'unbound', 'bound but unread')
    assert.equal(body.riskLevel, 'at_risk')
  })

  test('rejects a composition whose required slots are not all present', async () => {
    const response = await put({
      composition: { kind: 'arr' },
      components: SLOTS.slice(0, 2).map(driver),
    })
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.ok(JSON.stringify(body).includes('churned_arr'))
    // The rejected request must not have mutated anything.
    const count = await prisma.goalMetric.count({
      where: { organizationId, goalId, role: 'component' },
    })
    assert.equal(count, 4, 'a rejected edit leaves the goal untouched')
  })

  test('readings survive a save that does not rebind the source', async () => {
    const component = await prisma.goalMetric.findFirst({
      where: { organizationId, goalId, slot: 'new_arr' },
      select: { id: true },
    })
    const now = new Date()
    await prisma.metricDatapoint.create({
      data: {
        organizationId,
        goalMetricId: component.id,
        value: 400_000,
        capturedAt: now,
        bucketKey: now.toISOString().slice(0, 10),
        origin: 'manual',
      },
    })
    // Same source and metricKey, only the label changes.
    const response = await put({
      composition: { kind: 'arr' },
      components: SLOTS.map((slot) => ({
        ...driver(slot),
        label: slot === 'new_arr' ? 'New ARR (renamed)' : slot,
      })),
    })
    assert.equal(response.status, 200)
    const kept = await prisma.metricDatapoint.count({
      where: { organizationId, goalMetricId: component.id },
    })
    assert.equal(kept, 1, 'a rename must not discard readings')
  })

  test('rebinding a slot to a different source clears its stale readings', async () => {
    const component = await prisma.goalMetric.findFirst({
      where: { organizationId, goalId, slot: 'new_arr' },
      select: { id: true },
    })
    const response = await put({
      composition: { kind: 'arr' },
      components: SLOTS.map((slot) =>
        slot === 'new_arr'
          ? { ...driver(slot), source: 'url', metricKey: 'url.value', connectionRef: null, config: { url: 'https://example.com/arr.json' } }
          : driver(slot),
      ),
    })
    assert.equal(response.status, 200, await response.clone().text())
    const remaining = await prisma.metricDatapoint.count({
      where: { organizationId, goalMetricId: component.id },
    })
    // A reading from Stripe is not a reading from a URL — keeping it would
    // reconcile the new binding against the old source's number.
    assert.equal(remaining, 0, 'rebinding discards the old source readings')
  })

  test('per-source validation applies here too', async () => {
    const response = await put({
      composition: { kind: 'arr' },
      components: SLOTS.map((slot) =>
        slot === 'new_arr'
          ? { ...driver(slot), source: 'url', metricKey: 'url.value', config: { url: 'http://169.254.169.254/latest/meta-data' } }
          : driver(slot),
      ),
    })
    // The SSRF guard must not be reachable only through the create route.
    assert.equal(response.status, 400)
  })

  test('clearing the components removes the composition entirely', async () => {
    const response = await put({ composition: null, components: [] })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    const count = await prisma.goalMetric.count({
      where: { organizationId, goalId, role: 'component' },
    })
    assert.equal(count, 0)
    const goal = await prisma.goal.findFirst({
      where: { id: goalId, organizationId },
      select: { composition: true, compositionState: true },
    })
    assert.equal(goal.composition, null)
    assert.equal(goal.compositionState, null, 'an uncomposed goal reports no state')
  })

  test('another org cannot bind drivers on this goal', async () => {
    const { seedTestOrg, installTestAuth } = await import(
      '@/lib/server/__tests__/test-auth'
    )
    const other = await seedTestOrg(prisma)
    installTestAuth(other.auth)
    try {
      const response = await put({
        composition: { kind: 'arr' },
        components: SLOTS.map(driver),
      })
      assert.equal(response.status, 404, 'another org must not even find it')
    } finally {
      installTestAuth(seeded.auth)
    }
  })
}
