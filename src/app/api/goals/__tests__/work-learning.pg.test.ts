/**
 * Real-Postgres drive for the learning loader. Inert without
 * TEST_DATABASE_URL. Proves org scoping, level-1-over-level-2 precedence,
 * and that retired rules never reach a prompt.
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

  async function loadFeedback() {
    const { loadWorkFeedback } = await import('@/lib/goals/work-rules-port')
    return loadWorkFeedback(seeded.organizationId, goalId, 'agent-1')
  }

  test('a goal with no work and no rules yields null, not an empty block', async () => {
    assert.equal(await loadFeedback(), null)
  })

  test('active rules load; retired ones never do', async () => {
    const base = {
      organizationId: seeded.organizationId,
      goalId,
      resourceId: 'agent-1',
      skippedCount: 6,
      totalCount: 7,
    }
    await prisma.goalWorkRule.create({
      data: { ...base, signal: 'daysCold', statement: 'Skip cold under 14.' },
    })
    await prisma.goalWorkRule.create({
      data: {
        ...base,
        signal: 'contacts',
        statement: 'Skip single-contact deals.',
        status: 'retired',
        retiredAt: new Date(),
        retiredReason: 'probes_contradicted',
      },
    })

    const feedback = await loadFeedback()
    const statements = feedback!.rules.map((rule) => rule.statement)
    assert.deepEqual(statements, ['Skip cold under 14.'])
  })

  test('a level-1 rule wins over a level-2 rule on the same signal', async () => {
    await prisma.goalWorkRule.create({
      data: {
        organizationId: seeded.organizationId,
        goalId: null,
        resourceId: null,
        seedKey: 'sales-sequence-personalizer',
        signal: 'daysCold',
        statement: 'Org-wide: skip cold under 30.',
        skippedCount: 10,
        totalCount: 12,
      },
    })
    const feedback = await loadFeedback()
    const statements = feedback!.rules.map((rule) => rule.statement)
    assert.ok(statements.includes('Skip cold under 14.'), 'the narrower rule survives')
    assert.equal(
      statements.includes('Org-wide: skip cold under 30.'),
      false,
      'the seed-level rule on the same signal is dropped',
    )
  })

  test('a level-2 rule on a DIFFERENT signal is kept', async () => {
    await prisma.goalWorkRule.create({
      data: {
        organizationId: seeded.organizationId,
        goalId: null,
        resourceId: null,
        seedKey: 'sales-sequence-personalizer',
        signal: 'ownerTenureDays',
        statement: 'Org-wide: skip brand-new owners.',
        skippedCount: 8,
        totalCount: 9,
      },
    })
    const feedback = await loadFeedback()
    const statements = feedback!.rules.map((rule) => rule.statement)
    assert.ok(statements.includes('Org-wide: skip brand-new owners.'))
  })

  test('another org with identical rules never leaks in', async () => {
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const other = await seedTestOrg(prisma)
    await prisma.goalWorkRule.create({
      data: {
        organizationId: other.organizationId,
        goalId,
        resourceId: 'agent-1',
        signal: 'stage',
        statement: 'THEIRS — must never appear.',
        skippedCount: 9,
        totalCount: 9,
      },
    })
    await other.cleanup()
    installTestAuth(seeded.auth)

    const feedback = await loadFeedback()
    const statements = feedback!.rules.map((rule) => rule.statement)
    assert.equal(
      statements.some((statement) => statement.includes('THEIRS')),
      false,
    )
  })

  test('skip reasons are counted and ordered by frequency', async () => {
    const work = (skipReason: string | null, disposition = 'skipped') =>
      prisma.goalWork.create({
        data: {
          organizationId: seeded.organizationId,
          goalId,
          resourceType: 'agent',
          resourceId: 'agent-1',
          subject: `S-${Math.random()}`,
          produced: 're-entry email',
          disposition,
          skipReason,
        },
      })
    await work('too_early')
    await work('too_early')
    await work('wrong_contact')
    await work(null, 'used')

    const feedback = await loadFeedback()
    assert.deepEqual(feedback!.skipReasons, [
      { reason: 'too_early', count: 2 },
      { reason: 'wrong_contact', count: 1 },
    ])
    assert.equal(feedback!.stats.produced, 4)
    assert.equal(feedback!.stats.used, 1)
  })
}
