/**
 * The DB-backed halves of the goals tool plane, agent bundles and the GA4
 * adapter, against a real Postgres with real route handlers.
 *
 * These are the paths the unit suites deliberately could not reach: template
 * provenance persisting through the create route, the goals tool plane's
 * Prisma port actually writing a datapoint, plane scoping resolved from
 * GoalContribution rows, and the GA4 property route's failure modes.
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
  let seededCleanup: (() => Promise<void>) | undefined
  let otherCleanup: (() => Promise<void>) | undefined

  /** A goal plus its primary metric, owned by the seeded org. */
  const makeGoal = async (source: string, name: string) => {
    const goal = await prisma.goal.create({
      data: {
        organizationId: seeded.organizationId,
        name,
        kind: 'custom_kpi',
        direction: 'increase',
        unit: 'count',
        startValue: 0,
        targetValue: 100,
        startAt: new Date('2026-07-01T00:00:00Z'),
        targetDate: new Date('2026-12-31T00:00:00Z'),
        createdByUserId: seeded.userId,
      },
    })
    await prisma.goalMetric.create({
      data: {
        organizationId: seeded.organizationId,
        goalId: goal.id,
        role: 'primary',
        source,
        metricKey: `${source}.value`,
        config: {},
      },
    })
    return goal.id
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    otherOrg = await seedTestOrg(prisma)
    seededCleanup = seeded.cleanup
    otherCleanup = otherOrg.cleanup
    installTestAuth(seeded.auth)
  })

  after(async () => {
    // Cascade-delete both seeded orgs. The suite shares one database, and
    // sendWeeklyGoalDigests counts digests across ALL orgs — leaving goals
    // behind makes goals-e2e's `sent === 1` assertion fail depending on file
    // order. Tests must leave the database as they found it.
    await seededCleanup?.()
    await otherCleanup?.()
    await prisma?.$disconnect?.()
  })

  // ── Template provenance ────────────────────────────────────────────────────

  test('the create route persists templateKey, and the detail route returns it', async () => {
    const { POST } = await import('@/app/api/goals/route')
    const response = await POST(
      new NextRequest('http://localhost/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Organic sessions',
          kind: 'custom_kpi',
          unit: 'count',
          startValue: 0,
          targetValue: 5000,
          targetDate: '2026-12-31T00:00:00.000Z',
          templateKey: 'marketing-org-organic-traffic',
          metric: { source: 'manual', metricKey: 'manual.value', config: {} },
        }),
      }),
    )
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    const row = await prisma.goal.findFirst({
      where: { organizationId: seeded.organizationId, id: body.goal.id },
      select: { templateKey: true },
    })
    assert.equal(row.templateKey, 'marketing-org-organic-traffic')

    const { GET } = await import('@/app/api/goals/[id]/route')
    const detail = await GET(new NextRequest(`http://localhost/api/goals/${body.goal.id}`))
    const detailBody = await detail.json()
    assert.equal(detailBody.goal.templateKey, 'marketing-org-organic-traffic')
  })

  test('a goal created without a template stores null, not an empty string', async () => {
    // bundleForGoal branches on truthiness; '' would silently take the curated
    // path and resolve nothing instead of falling back to kind matching.
    const { POST } = await import('@/app/api/goals/route')
    const response = await POST(
      new NextRequest('http://localhost/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Copilot drafted',
          kind: 'custom_kpi',
          unit: 'count',
          startValue: 0,
          targetValue: 10,
          targetDate: '2026-12-31T00:00:00.000Z',
          metric: { source: 'manual', metricKey: 'manual.value', config: {} },
        }),
      }),
    )
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    const row = await prisma.goal.findFirst({
      where: { organizationId: seeded.organizationId, id: body.goal.id },
      select: { templateKey: true },
    })
    assert.equal(row.templateKey, null)
  })

  // ── Goals tool plane: the Prisma port ─────────────────────────────────────

  test('log_datapoint writes origin=assisted and upserts within the same UTC day', async () => {
    const { GoalsToolClient } = await import('@/lib/integrations/goals')
    const { prismaGoalsPort } = await import('@/lib/integrations/goals-port')
    const goalId = await makeGoal('manual', 'Manual tracked goal')
    const client = new GoalsToolClient([goalId], prismaGoalsPort(seeded.organizationId))

    await client.executeTool('', 'log_datapoint', { value: 42 })
    await client.executeTool('', 'log_datapoint', { value: 57 })

    const metric = await prisma.goalMetric.findFirst({
      where: { organizationId: seeded.organizationId, goalId },
      select: { id: true },
    })
    const points = await prisma.metricDatapoint.findMany({
      where: { organizationId: seeded.organizationId, goalMetricId: metric.id },
      select: { value: true, origin: true, bucketKey: true },
    })
    // One row per metric per UTC day: the second write replaces, never appends.
    assert.equal(points.length, 1)
    assert.equal(points[0].value, 57)
    assert.equal(points[0].origin, 'assisted')
  })

  test('log_datapoint refuses a system-of-record goal and writes nothing', async () => {
    const { GoalsToolClient } = await import('@/lib/integrations/goals')
    const { prismaGoalsPort } = await import('@/lib/integrations/goals-port')
    const goalId = await makeGoal('stripe', 'Stripe tracked goal')
    const client = new GoalsToolClient([goalId], prismaGoalsPort(seeded.organizationId))

    await assert.rejects(
      () => client.executeTool('', 'log_datapoint', { value: 99 }),
      /Cannot write this goal's value/,
    )
    const metric = await prisma.goalMetric.findFirst({
      where: { organizationId: seeded.organizationId, goalId },
      select: { id: true },
    })
    const count = await prisma.metricDatapoint.count({
      where: { organizationId: seeded.organizationId, goalMetricId: metric.id },
    })
    assert.equal(count, 0)
  })

  test('get_pace reads real datapoints through the port', async () => {
    const { GoalsToolClient } = await import('@/lib/integrations/goals')
    const { prismaGoalsPort } = await import('@/lib/integrations/goals-port')
    const goalId = await makeGoal('manual', 'Paced goal')
    const client = new GoalsToolClient([goalId], prismaGoalsPort(seeded.organizationId))

    await client.executeTool('', 'log_datapoint', { value: 25 })
    const pace = (await client.executeTool('', 'get_pace', {})) as {
      currentValue: number
      targetValue: number
      riskLevel: string
    }
    assert.equal(pace.currentValue, 25)
    assert.equal(pace.targetValue, 100)
    assert.ok(typeof pace.riskLevel === 'string')
  })

  test('a goal in another organization is unreachable even if its id is known', async () => {
    const { GoalsToolClient } = await import('@/lib/integrations/goals')
    const { prismaGoalsPort } = await import('@/lib/integrations/goals-port')
    const foreign = await prisma.goal.create({
      data: {
        organizationId: otherOrg.organizationId,
        name: 'Other org goal',
        kind: 'custom_kpi',
        direction: 'increase',
        unit: 'count',
        startValue: 0,
        targetValue: 10,
        startAt: new Date('2026-07-01T00:00:00Z'),
        targetDate: new Date('2026-12-31T00:00:00Z'),
        createdByUserId: otherOrg.userId,
      },
    })
    // Even with the id in the constructed scope, the port is org-scoped.
    const client = new GoalsToolClient([foreign.id], prismaGoalsPort(seeded.organizationId))
    await assert.rejects(
      () => client.executeTool('', 'get_goal', {}),
      /no longer exists/,
    )
  })

  // ── Goals tool plane: scoping from GoalContribution ───────────────────────

  test('the goals plane is absent until a contribution links the resource', async () => {
    const { loadNativePlaneGroups } = await import('@/features/agents/tool-planes')
    const goalId = await makeGoal('manual', 'Plane scoping goal')

    const before = await loadNativePlaneGroups(seeded.organizationId, {
      providers: ['goals'],
      resource: { type: 'agent', id: 'agent-unlinked' },
    })
    assert.equal(
      before.some((group: any) => group.provider === 'sublime-goals'),
      false,
      'an unlinked agent must not see the goals tools',
    )

    await prisma.goalContribution.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceType: 'agent',
        resourceId: 'agent-linked',
        origin: 'manual',
        seedKey: 'goal-pace-auditor',
      },
    })
    const after = await loadNativePlaneGroups(seeded.organizationId, {
      providers: ['goals'],
      resource: { type: 'agent', id: 'agent-linked' },
    })
    const group = after.find((candidate: any) => candidate.provider === 'sublime-goals')
    assert.ok(group, 'a linked agent must receive the goals tools')
    assert.deepEqual(
      group.tools.map((tool: any) => tool.name).sort(),
      ['get_goal', 'get_pace', 'list_datapoints', 'log_datapoint'],
    )
  })

  test('an agent that never selected goals does not receive the plane', async () => {
    const { loadNativePlaneGroups } = await import('@/features/agents/tool-planes')
    const groups = await loadNativePlaneGroups(seeded.organizationId, {
      providers: ['slack'],
      resource: { type: 'agent', id: 'agent-linked' },
    })
    assert.equal(
      groups.some((group: any) => group.provider === 'sublime-goals'),
      false,
    )
  })

  // ── Re-deploy must not double-link a goal ─────────────────────────────────

  test('re-deploying a seed returns the existing resource instead of a duplicate', async () => {
    const { POST } = await import('@/app/api/templates/provision/route')
    const goalId = await makeGoal('manual', 'Redeploy guard goal')

    // Stand in for a first successful deploy of this seed.
    await prisma.goalContribution.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceType: 'agent',
        resourceId: 'agent-already-deployed',
        origin: 'manual',
        seedKey: 'goal-metric-collector',
        estimatedMinutesSavedPerRun: 15,
      },
    })

    const response = await POST(
      new NextRequest('http://localhost/api/templates/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seedKey: 'goal-metric-collector', goalId }),
      }),
    )
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.alreadyDeployed, true)
    assert.equal(body.agentId, 'agent-already-deployed')

    // One link for one seed — goalImpact() counts contributions, so a second
    // row here would double-count the agent's runs against this goal.
    const links = await prisma.goalContribution.findMany({
      where: { organizationId: seeded.organizationId, goalId, seedKey: 'goal-metric-collector' },
      select: { resourceId: true },
    })
    assert.equal(links.length, 1)
  })

  // ── GA4 property discovery ────────────────────────────────────────────────

  test('the GA4 property route rejects a missing connectionRef as a client error', async () => {
    const { GET } = await import('@/app/api/goals/metrics/ga4/properties/route')
    const response = await GET(new NextRequest('http://localhost/api/goals/metrics/ga4/properties'))
    // A caller mistake must not read as a server fault.
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.success, false)
  })

  test('the GA4 property route rejects a non-google connection plane', async () => {
    const { GET } = await import('@/app/api/goals/metrics/ga4/properties/route')
    const response = await GET(
      new NextRequest(
        'http://localhost/api/goals/metrics/ga4/properties?connectionRef=nango:abc',
      ),
    )
    assert.equal(response.status, 400)
  })

  test('an unreachable GA4 connection yields an empty picker, never a 500', async () => {
    const { GET } = await import('@/app/api/goals/metrics/ga4/properties/route')
    const response = await GET(
      new NextRequest(
        'http://localhost/api/goals/metrics/ga4/properties?connectionRef=google:does-not-exist',
      ),
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.properties, [])
  })
}
