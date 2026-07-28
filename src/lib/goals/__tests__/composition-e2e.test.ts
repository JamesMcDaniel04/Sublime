/**
 * ARR composition against the throwaway Postgres: create a composed goal, seed
 * component readings, evaluate, and assert gating plus the settlement receipt.
 * Skipped unless TEST_DATABASE_URL is present.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const DAY = 24 * 60 * 60 * 1000
  let prisma: any
  let seeded: any
  let goalId = ''
  let organizationId = ''
  const SLOTS = ['new_arr', 'expansion_arr', 'contraction_arr', 'churned_arr']
  const componentIds: Record<string, string> = {}
  // 2M start, 3M target, day 50 of 100. A 2.5M headline is progress 0.5 vs
  // expected 0.5, so the BASE evaluation is on_track — gates only downgrade,
  // so an already-behind base would make these assertions vacuous.
  const now = new Date()
  const bucket = (date: Date) => date.toISOString().slice(0, 10)

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import(
      '@/lib/server/__tests__/test-auth'
    )
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId

    const goal = await prisma.goal.create({
      data: {
        organizationId,
        name: 'ARR to 3M',
        kind: 'arr',
        direction: 'increase',
        unit: 'usd',
        startValue: 2_000_000,
        targetValue: 3_000_000,
        startAt: new Date(now.getTime() - 50 * DAY),
        targetDate: new Date(now.getTime() + 50 * DAY),
        createdByUserId: seeded.userId,
        composition: { kind: 'arr' },
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
    await prisma.metricDatapoint.create({
      data: {
        organizationId,
        goalMetricId: primary.id,
        value: 2_500_000,
        capturedAt: now,
        bucketKey: bucket(now),
        origin: 'manual',
      },
    })
    for (const slot of SLOTS) {
      const row = await prisma.goalMetric.create({
        data: {
          organizationId,
          goalId,
          role: 'component',
          slot,
          source: 'manual',
          metricKey: 'manual.value',
          config: {},
        },
      })
      componentIds[slot] = row.id
    }
  })

  after(async () => {
    await prisma.$disconnect()
  })

  test('component slots are unique per goal but NULL slots coexist', async () => {
    // The whole component model rests on Postgres treating NULLs as distinct.
    await assert.rejects(
      () =>
        prisma.goalMetric.create({
          data: {
            organizationId,
            goalId,
            role: 'component',
            slot: 'new_arr',
            source: 'manual',
            metricKey: 'manual.value',
            config: {},
          },
        }),
      /unique/i,
    )
    // Two supporting metrics, both slot NULL, must both insert.
    for (const label of ['extra one', 'extra two']) {
      await prisma.goalMetric.create({
        data: {
          organizationId,
          goalId,
          role: 'supporting',
          label,
          source: 'manual',
          metricKey: 'manual.value',
          config: {},
        },
      })
    }
    const nullSlots = await prisma.goalMetric.count({
      where: { organizationId, goalId, slot: null },
    })
    assert.ok(nullSlots >= 3, 'primary + two supporting all carry a null slot')
  })

  test('an unbound composition gates the goal at at_risk', async () => {
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, organizationId, now)
    const after = await prisma.goal.findFirst({ where: { id: goalId, organizationId } })
    assert.equal(after.riskLevel, 'at_risk')
    assert.equal(after.compositionState.level, 'unbound')
    assert.equal(after.compositionState.missing.length, 4)
    assert.equal(after.compositionState.derived, null)
  })

  test('a complete, reconciling composition clears the gate', async () => {
    const values: Record<string, number> = {
      new_arr: 400_000,
      expansion_arr: 200_000,
      contraction_arr: 40_000,
      churned_arr: 60_000,
    }
    for (const slot of SLOTS) {
      await prisma.metricDatapoint.create({
        data: {
          organizationId,
          goalMetricId: componentIds[slot],
          value: values[slot],
          capturedAt: now,
          bucketKey: bucket(now),
          origin: 'manual',
        },
      })
    }
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, organizationId, now)
    const after = await prisma.goal.findFirst({ where: { id: goalId, organizationId } })
    // 2M + (400k + 200k − 40k − 60k) = 2.5M, exactly the read headline.
    assert.equal(after.compositionState.level, 'complete')
    assert.equal(after.compositionState.reconciliation, 'reconciled')
    assert.equal(after.compositionState.derived, 2_500_000)
    assert.deepEqual(after.compositionState.reasons, [])
    assert.equal(after.riskLevel, 'on_track')
  })

  test('drifting a component downgrades to at_risk with a reason', async () => {
    await prisma.metricDatapoint.update({
      where: {
        goalMetricId_bucketKey: {
          goalMetricId: componentIds.new_arr,
          bucketKey: bucket(now),
        },
        organizationId,
      },
      data: { value: 1_400_000 },
    })
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, organizationId, now)
    const after = await prisma.goal.findFirst({ where: { id: goalId, organizationId } })
    assert.equal(after.compositionState.reconciliation, 'drifted')
    assert.equal(after.riskLevel, 'at_risk')
    assert.ok(
      after.compositionState.reasons.some((reason: string) =>
        reason.includes('reconcile'),
      ),
    )
    // Put it back so the settlement test below reconciles.
    await prisma.metricDatapoint.update({
      where: {
        goalMetricId_bucketKey: {
          goalMetricId: componentIds.new_arr,
          bucketKey: bucket(now),
        },
        organizationId,
      },
      data: { value: 400_000 },
    })
  })

  test('a non-recurring goal writes a GoalPeriod receipt when it settles', async () => {
    // Push the deadline into the past and lower the target so the outcome is
    // 'achieved' against the 2.5M headline.
    await prisma.goal.update({
      where: { id: goalId, organizationId },
      data: {
        targetDate: new Date(now.getTime() - DAY),
        targetValue: 2_400_000,
      },
    })
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, organizationId, now)

    const settled = await prisma.goal.findFirst({ where: { id: goalId, organizationId } })
    assert.equal(settled.status, 'achieved')

    const periods = await prisma.goalPeriod.findMany({ where: { goalId, organizationId } })
    assert.equal(periods.length, 1, 'exactly one settlement receipt')
    const receipt = periods[0]
    assert.equal(receipt.outcome, 'achieved')
    assert.equal(receipt.targetValue, 2_400_000)
    assert.equal(receipt.finalValue, 2_500_000, 'the value that decided it')
    assert.ok(Array.isArray(receipt.compositionSnapshot), 'components recorded')
    assert.equal(receipt.compositionSnapshot.length, 4)
    assert.equal(typeof receipt.reconciliationVariancePct, 'number')
    // Snapshot carries provenance, not just numbers.
    const slots = receipt.compositionSnapshot.map((entry: any) => entry.slot).sort()
    assert.deepEqual(slots, [...SLOTS].sort())
  })

  test('settling twice does not write a second receipt', async () => {
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, organizationId, now)
    const periods = await prisma.goalPeriod.findMany({ where: { goalId, organizationId } })
    assert.equal(periods.length, 1, 'settlement is idempotent')
  })
}
