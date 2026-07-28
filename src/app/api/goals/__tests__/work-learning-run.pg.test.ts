/**
 * The weekly learning tick, driven against real Postgres. Inert without
 * TEST_DATABASE_URL.
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
    await prisma.goalContribution.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceType: 'agent',
        resourceId: 'agent-1',
        origin: 'manual',
        seedKey: 'sales-sequence-personalizer',
      },
    })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const work = (overrides: Record<string, unknown>) =>
    prisma.goalWork.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceType: 'agent',
        resourceId: 'agent-1',
        subject: `S-${Math.random()}`,
        produced: 're-entry email',
        ...overrides,
      },
    })

  const run = async () => {
    const { runGoalWorkLearning } = await import('@/lib/goals/run-work-learning')
    return runGoalWorkLearning(seeded.organizationId, prisma)
  }

  test('a clean signal split earns a rule', async () => {
    for (const daysCold of [3, 5, 7, 9, 11]) {
      await work({ disposition: 'skipped', skipReason: 'too_early', signals: { daysCold } })
    }
    for (const daysCold of [30, 40, 50]) {
      await work({ disposition: 'used', signals: { daysCold } })
    }

    const stats = await run()
    assert.equal(stats.rulesLearned, 1)

    const rule = await prisma.goalWorkRule.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, goalId, status: 'active' },
    })
    assert.equal(rule.signal, 'daysCold')
    assert.equal(rule.topSkipReason, 'too_early')
    assert.equal(rule.exploreRate, 0.2)
    assert.match(rule.statement, /under/i)
  })

  test('running twice does not duplicate the rule', async () => {
    await run()
    const count = await prisma.goalWorkRule.count({
      where: { organizationId: seeded.organizationId, goalId, signal: 'daysCold', status: 'active' },
    })
    assert.equal(count, 1, 'the partial unique index and the runner must agree')
  })

  test('probes that come back used retire the rule', async () => {
    const rule = await prisma.goalWorkRule.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, goalId, signal: 'daysCold', status: 'active' },
    })
    for (let index = 0; index < 3; index += 1) {
      await work({ disposition: 'used', signals: { daysCold: 4 }, probeForRuleId: rule.id })
    }
    await work({
      disposition: 'skipped',
      skipReason: 'too_early',
      signals: { daysCold: 4 },
      probeForRuleId: rule.id,
    })

    const stats = await run()
    assert.ok(stats.rulesRetired >= 1)

    const retired = await prisma.goalWorkRule.findFirstOrThrow({
      where: { id: rule.id, organizationId: seeded.organizationId },
    })
    assert.equal(retired.status, 'retired')
    assert.equal(retired.retiredReason, 'probes_contradicted')
  })

  test('probes never count as evidence for re-earning the rule they test', async () => {
    // The 4 probes above all had daysCold 4. If they counted, the rule would
    // immediately re-earn itself from its own exceptions.
    const active = await prisma.goalWorkRule.count({
      where: { organizationId: seeded.organizationId, goalId, signal: 'daysCold', status: 'active' },
    })
    assert.equal(active, 1, 'exactly the one relearned from non-probe evidence')
  })

  test('the tick never throws on an org with no goals at all', async () => {
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const empty = await seedTestOrg(prisma)
    const { runGoalWorkLearning } = await import('@/lib/goals/run-work-learning')
    const stats = await runGoalWorkLearning(empty.organizationId, prisma)
    assert.deepEqual(
      { learned: stats.rulesLearned, retired: stats.rulesRetired },
      { learned: 0, retired: 0 },
    )
    await empty.cleanup()
    installTestAuth(seeded.auth)
  })
}
