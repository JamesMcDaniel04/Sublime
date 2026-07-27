/**
 * Goal recovery-plan routes against a real Postgres: seeded auth context,
 * REAL route handlers driven with NextRequest objects. Generation itself is
 * unit-tested with stubs (recovery.test.ts) — these rows are seeded directly
 * so the smoke never depends on a live LLM.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let otherOrg: any
  let goalId: string
  let planId: string
  let actionIds: Record<string, string>

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    otherOrg = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)

    const goal = await prisma.goal.create({
      data: {
        organizationId: seeded.organizationId,
        name: 'Smoke ARR goal',
        kind: 'arr',
        direction: 'increase',
        unit: 'usd',
        startValue: 100,
        targetValue: 200,
        startAt: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-12-31T00:00:00Z'),
        riskLevel: 'off_track',
        createdByUserId: seeded.userId,
      },
    })
    goalId = goal.id
    const plan = await prisma.goalRecoveryPlan.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        triggerRiskLevel: 'off_track',
        diagnosis: 'Behind pace.',
        evidence: ['Smoke ARR goal: $120 is $30 behind pace ($150 expected by today).'],
        actions: {
          create: [
            {
              organizationId: seeded.organizationId,
              kind: 'manual_step',
              title: 'Review pipeline',
              rationale: 'r',
              rank: 0,
            },
            {
              organizationId: seeded.organizationId,
              kind: 'connect_tool',
              title: 'Connect Stripe',
              rationale: 'r',
              payload: { source: 'stripe' },
              rank: 1,
            },
            {
              organizationId: seeded.organizationId,
              kind: 'launch_agent',
              title: 'Deploy reviver',
              rationale: 'r',
              payload: { seedKey: 'sales-new-lead-to-sf-opportunity' },
              rank: 2,
            },
          ],
        },
      },
      include: { actions: { orderBy: { rank: 'asc' } } },
    })
    planId = plan.id
    actionIds = {
      manual: plan.actions[0].id,
      connect: plan.actions[1].id,
      launch: plan.actions[2].id,
    }
    await prisma.userSuggestion.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        kind: 'goal_action',
        title: 'Smoke ARR goal is off track',
        description: 'Behind pace.',
        targetType: 'goal',
        targetId: goalId,
        status: 'open',
        metadata: { goalId, planId },
      },
    })
  })

  after(async () => {
    if (otherOrg) await otherOrg.cleanup()
    if (seeded) await seeded.cleanup()
  })

  const req = (path: string, init?: RequestInit) =>
    new NextRequest(new URL(`http://test${path}`), init as never)
  const post = (path: string, body: unknown) =>
    req(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  const getGoal = async () => {
    const { GET } = await import('../goals/[id]/route')
    const res = await GET(req(`/api/goals/${goalId}`))
    assert.equal(res.status, 200)
    return (await res.json()).goal
  }

  test('GET goal payload carries the open plan with rank-ordered actions', async () => {
    const goal = await getGoal()
    assert.equal(goal.recoveryPlan.id, planId)
    assert.equal(goal.recoveryPlan.triggerRiskLevel, 'off_track')
    assert.deepEqual(
      goal.recoveryPlan.actions.map((action: { kind: string }) => action.kind),
      ['manual_step', 'connect_tool', 'launch_agent'],
    )
    assert.ok(goal.recoveryPlan.evidence[0].includes('behind pace'))
  })

  test('cross-org auth cannot touch the plan and changes nothing', async () => {
    const { installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    installTestAuth(otherOrg.auth)
    const { POST } = await import('../goals/[id]/recovery/actions/[actionId]/route')
    const res = await POST(
      post(`/api/goals/${goalId}/recovery/actions/${actionIds.manual}`, { op: 'accept' }),
    )
    assert.equal(res.status, 404)
    installTestAuth(seeded.auth)
    const action = await prisma.goalRecoveryAction.findFirst({
      where: { id: actionIds.manual, organizationId: seeded.organizationId },
    })
    assert.equal(action.status, 'proposed')
  })

  test('accepting a manual_step completes it', async () => {
    const { POST } = await import('../goals/[id]/recovery/actions/[actionId]/route')
    const res = await POST(
      post(`/api/goals/${goalId}/recovery/actions/${actionIds.manual}`, { op: 'accept' }),
    )
    assert.equal(res.status, 200)
    assert.equal((await res.json()).status, 'done')
    const goal = await getGoal()
    const action = goal.recoveryPlan.actions.find(
      (candidate: { id: string }) => candidate.id === actionIds.manual,
    )
    assert.equal(action.status, 'done')
  })

  test('accepting a connect_tool returns the integrations deep-link', async () => {
    const { POST } = await import('../goals/[id]/recovery/actions/[actionId]/route')
    const res = await POST(
      post(`/api/goals/${goalId}/recovery/actions/${actionIds.connect}`, { op: 'accept' }),
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'accepted')
    assert.equal(body.href, '/integrations')
  })

  test('accepting a launch_agent hands back a provision body', async () => {
    const { POST } = await import('../goals/[id]/recovery/actions/[actionId]/route')
    const res = await POST(
      post(`/api/goals/${goalId}/recovery/actions/${actionIds.launch}`, { op: 'accept' }),
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'accepted')
    assert.deepEqual(body.provision, {
      seedKey: 'sales-new-lead-to-sf-opportunity',
      goalId,
      recoveryActionId: actionIds.launch,
    })
  })

  test('dismissing the plan clears it and closes the pointer suggestion', async () => {
    const { POST } = await import('../goals/[id]/recovery/route')
    const res = await POST(post(`/api/goals/${goalId}/recovery`, { op: 'dismiss' }))
    assert.equal(res.status, 200)
    const goal = await getGoal()
    assert.equal(goal.recoveryPlan, null)
    const suggestion = await prisma.userSuggestion.findFirst({
      where: {
        organizationId: seeded.organizationId,
        kind: 'goal_action',
        targetType: 'goal',
        targetId: goalId,
      },
    })
    assert.equal(suggestion.status, 'dismissed')
  })
} else {
  test('goal-recovery e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
