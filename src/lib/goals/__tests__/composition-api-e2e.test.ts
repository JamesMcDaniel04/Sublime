/**
 * Composed-goal creation and PATCH through the real route handlers against the
 * throwaway Postgres. Skipped unless TEST_DATABASE_URL is present.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const DAY = 24 * 60 * 60 * 1000
  let prisma: any
  let seeded: any
  let organizationId = ''
  const targetDate = new Date(Date.now() + 180 * DAY).toISOString()

  const component = (slot: string, label: string) => ({
    source: 'manual',
    metricKey: 'manual.value',
    label,
    role: 'component' as const,
    slot,
    config: {},
  })

  const arrBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'ARR with drivers',
    kind: 'arr',
    direction: 'increase',
    unit: 'usd',
    startValue: 2_000_000,
    targetValue: 3_000_000,
    targetDate,
    recurrence: null,
    personal: false,
    composition: { kind: 'arr' },
    metrics: [
      {
        source: 'manual',
        metricKey: 'manual.value',
        label: 'Total ARR',
        role: 'primary',
        config: {},
      },
      component('new_arr', 'New ARR'),
      component('expansion_arr', 'Expansion ARR'),
      component('contraction_arr', 'Contraction ARR'),
      component('churned_arr', 'Churned ARR'),
    ],
    ...overrides,
  })

  const post = async (body: unknown) => {
    const route = await import('@/app/api/goals/route')
    return route.POST(
      new NextRequest('http://test/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import(
      '@/lib/server/__tests__/test-auth'
    )
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
  })

  after(async () => {
    await prisma.$disconnect()
  })

  test('creates a composed ARR goal with four component metrics', async () => {
    const response = await post(arrBody())
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    const metrics = await prisma.goalMetric.findMany({
      where: { organizationId, goalId: body.goal.id },
      select: { role: true, slot: true },
    })
    assert.equal(metrics.length, 5, 'one headline plus four components')
    const slots = metrics
      .filter((m: any) => m.role === 'component')
      .map((m: any) => m.slot)
      .sort()
    assert.deepEqual(slots, [
      'churned_arr',
      'contraction_arr',
      'expansion_arr',
      'new_arr',
    ])
    // The headline carries no slot — NULLs are distinct, so it never collides.
    assert.equal(metrics.find((m: any) => m.role === 'primary').slot, null)

    const goal = await prisma.goal.findFirst({
      where: { id: body.goal.id, organizationId },
      select: { composition: true },
    })
    assert.deepEqual(goal.composition, { kind: 'arr' })
  })

  test('rejects a composition missing a required component', async () => {
    const response = await post(
      arrBody({
        metrics: arrBody().metrics.slice(0, 4), // drops churned_arr
      }),
    )
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.ok(
      JSON.stringify(body).includes('churned_arr'),
      `expected churned_arr in ${JSON.stringify(body)}`,
    )
  })

  test('rejects a component whose slot is not in the kind vocabulary', async () => {
    const response = await post(
      arrBody({
        metrics: [...arrBody().metrics, component('nwe_arr', 'Typo')],
      }),
    )
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.ok(JSON.stringify(body).includes('nwe_arr'))
  })

  test('rejects a component metric with no slot', async () => {
    const metrics = arrBody().metrics.map((metric: any) =>
      metric.role === 'component' ? { ...metric, slot: undefined } : metric,
    )
    const response = await post(arrBody({ metrics }))
    assert.equal(response.status, 400)
  })

  test('rejects a composition whose kind contradicts the goal kind', async () => {
    const response = await post(arrBody({ composition: { kind: 'quota' } }))
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.ok(JSON.stringify(body).includes('match'))
  })

  test('an uncomposed goal still creates exactly as before', async () => {
    const response = await post({
      name: 'Plain KPI',
      kind: 'kpi',
      direction: 'decrease',
      unit: 'usd',
      startValue: 100_000,
      targetValue: 60_000,
      targetDate,
      recurrence: null,
      personal: false,
      metric: { source: 'manual', metricKey: 'manual.value', config: {} },
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    const goal = await prisma.goal.findFirst({
      where: { id: body.goal.id, organizationId },
      select: { composition: true, compositionState: true, direction: true },
    })
    assert.equal(goal.composition, null)
    assert.equal(goal.compositionState, null)
    // A decreasing KPI is reachable now that 'savings' no longer implies it.
    assert.equal(goal.direction, 'decrease')
  })

  test('PATCH validates a composition against the slots actually bound', async () => {
    const created = await post({
      name: 'KPI to compose later',
      kind: 'kpi',
      direction: 'increase',
      unit: 'count',
      startValue: 0,
      targetValue: 100,
      targetDate,
      recurrence: null,
      personal: false,
      metric: { source: 'manual', metricKey: 'manual.value', config: {} },
    })
    const { goal } = await created.json()
    const route = await import('@/app/api/goals/[id]/route')
    const patch = (composition: unknown) =>
      route.PATCH(
        new NextRequest(`http://test/api/goals/${goal.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ composition }),
        }),
      )

    // No components are bound, so a ratio shape cannot be satisfied.
    const rejected = await patch({ kind: 'kpi', shape: 'ratio' })
    assert.equal(rejected.status, 400)
    assert.ok(JSON.stringify(await rejected.json()).includes('numerator'))

    // Bind them, then the same PATCH succeeds.
    for (const slot of ['numerator', 'denominator']) {
      await prisma.goalMetric.create({
        data: {
          organizationId,
          goalId: goal.id,
          role: 'component',
          slot,
          source: 'manual',
          metricKey: 'manual.value',
          config: {},
        },
      })
    }
    const accepted = await patch({ kind: 'kpi', shape: 'ratio' })
    assert.equal(accepted.status, 200, JSON.stringify(await accepted.json()))
    const after = await prisma.goal.findFirst({
      where: { id: goal.id, organizationId },
      select: { composition: true },
    })
    assert.deepEqual(after.composition, { kind: 'kpi', shape: 'ratio' })
  })

  test('GET surfaces compositionState and component slots to the client', async () => {
    const created = await post(arrBody({ name: 'ARR for the strip' }))
    const { goal } = await created.json()

    // Evaluate once so compositionState exists — nothing is bound, so this is
    // the unbound case the strip renders as "not bound yet".
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goal.id, organizationId)

    const route = await import('@/app/api/goals/[id]/route')
    const response = await route.GET(
      new NextRequest(`http://test/api/goals/${goal.id}`),
    )
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    assert.ok(body.goal.compositionState, 'compositionState reaches the client')
    assert.equal(body.goal.compositionState.level, 'unbound')
    assert.equal(body.goal.compositionState.missing.length, 4)

    // Component series carry their slot so the UI can label them.
    const components = body.goal.metrics.filter((m: any) => m.role === 'component')
    assert.equal(components.length, 4)
    assert.deepEqual(
      components.map((m: any) => m.slot).sort(),
      ['churned_arr', 'contraction_arr', 'expansion_arr', 'new_arr'],
    )

    // And the strip turns that into copy rather than raw slot keys.
    const { compositionSummary } = await import(
      '@/components/goals/composition-strip'
    )
    const summary = compositionSummary(body.goal.compositionState)
    assert.equal(summary?.tone, 'unknown')
    assert.ok(summary.detail.join(' ').includes('Churned ARR'))
  })

  test('an uncomposed goal reports a null compositionState', async () => {
    const created = await post({
      name: 'No composition',
      kind: 'kpi',
      direction: 'increase',
      unit: 'count',
      startValue: 0,
      targetValue: 10,
      targetDate,
      recurrence: null,
      personal: false,
      metric: { source: 'manual', metricKey: 'manual.value', config: {} },
    })
    const { goal } = await created.json()
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goal.id, organizationId)
    const route = await import('@/app/api/goals/[id]/route')
    const body = await (
      await route.GET(new NextRequest(`http://test/api/goals/${goal.id}`))
    ).json()
    assert.equal(body.goal.compositionState, null)
    const { compositionSummary } = await import(
      '@/components/goals/composition-strip'
    )
    assert.equal(compositionSummary(body.goal.compositionState), null)
  })
}
