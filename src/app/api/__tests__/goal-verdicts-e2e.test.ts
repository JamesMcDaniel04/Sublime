/**
 * Run→goal verdict pipeline against a real Postgres: real default deps
 * (Prisma writes, notification emission), seeded rows — no LLM. The verdict
 * itself is unit-tested with stubs (verdicts.test.ts); this proves the
 * wiring: rows land in goal_run_verdicts, a 3-streak on an at-risk goal
 * notifies the owner, and the new Goal.priority / AgentExecution.plan
 * columns round-trip.
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
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    const goal = await prisma.goal.create({
      data: {
        organizationId: seeded.organizationId,
        name: 'Verdict smoke goal',
        kind: 'arr',
        direction: 'increase',
        unit: 'usd',
        startValue: 100,
        targetValue: 200,
        startAt: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-12-31T00:00:00Z'),
        riskLevel: 'at_risk',
        createdByUserId: seeded.userId,
        ownerUserId: seeded.userId,
      },
    })
    goalId = goal.id
    // Link the "agent" to the goal — resolveLinkedGoalIds reads this table.
    await prisma.goalContribution.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceType: 'agent',
        resourceId: 'smoke-agent-1',
        origin: 'manual',
      },
    })
  })

  after(async () => {
    await prisma.$disconnect()
  })

  test('three non-advancing verdicts persist and escalate to the owner exactly once', async () => {
    const { recordGoalRunVerdicts } = await import('@/lib/goals/verdicts')
    for (let run = 1; run <= 3; run += 1) {
      await recordGoalRunVerdicts({
        organizationId: seeded.organizationId,
        resourceType: 'agent',
        resourceId: 'smoke-agent-1',
        runId: `smoke-run-${run}`,
        verdict: 'no_change',
        evidence: `run ${run} produced nothing goal-moving`,
      })
    }
    const rows = await prisma.goalRunVerdict.findMany({
      where: { organizationId: seeded.organizationId, goalId },
      orderBy: { createdAt: 'asc' },
    })
    assert.equal(rows.length, 3)
    assert.ok(rows.every((row: { verdict: string }) => row.verdict === 'no_change'))

    const notifications = await prisma.notification.findMany({
      where: { organizationId: seeded.organizationId, type: 'goal.agent_stalled' },
    })
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].userId, seeded.userId)
    assert.match(notifications[0].title, /stopped advancing/)
  })

  test('goal priority and execution plan columns round-trip', async () => {
    await prisma.goal.update({
      where: { id: goalId, organizationId: seeded.organizationId },
      data: { priority: 1 },
    })
    const goal = await prisma.goal.findFirst({
      where: { id: goalId, organizationId: seeded.organizationId },
      select: { priority: true },
    })
    assert.equal(goal.priority, 1)

    const execution = await prisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        status: 'completed',
        input: {},
        trigger: { type: 'test' },
        userId: seeded.userId,
        organizationId: seeded.organizationId,
        plan: { steps: [{ n: 1, title: 'smoke', status: 'done' }], revisions: [] },
      },
    })
    const read = await prisma.agentExecution.findFirst({
      where: { id: execution.id, organizationId: seeded.organizationId },
      select: { plan: true },
    })
    assert.equal(read.plan.steps[0].title, 'smoke')
  })
} else {
  test('goal-verdicts e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
