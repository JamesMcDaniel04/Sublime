/**
 * Route-handler drive for the work queue. Real Postgres + seeded auth, per the
 * `verify` skill — jsdom cannot prove tenant scoping or transition refusals.
 * Inert without TEST_DATABASE_URL so `npm test` stays green.
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
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const makeItem = (overrides: Record<string, unknown> = {}) =>
    prisma.goalWork.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceType: 'agent',
        resourceId: 'agent-1',
        subject: 'Acme — deal 412',
        produced: 're-entry email',
        body: 'Following up…',
        ...overrides,
      },
    })

  const patch = async (workId: string, payload: Record<string, unknown>) => {
    const { PATCH } = await import('../[id]/work/[workId]/route')
    return PATCH(
      new NextRequest(`http://test/api/goals/${goalId}/work/${workId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  test('the queue lists open items and reports a goal-wide funnel', async () => {
    const item = await makeItem({ subjectRef: 'list-1' })
    const { GET } = await import('../[id]/work/route')
    const response = await GET(
      new NextRequest(`http://test/api/goals/${goalId}/work?filter=all`),
    )
    const body = await response.json()
    assert.ok(
      body.items.some((row: { id: string }) => row.id === item.id),
      'the created item must be listed',
    )
    assert.ok(body.stats.overall.produced >= 1)
  })

  test('Copy records used, stamping who and when', async () => {
    const item = await makeItem({ subjectRef: 'copy-1' })
    assert.equal((await patch(item.id, { disposition: 'used' })).status, 200)

    const after = await prisma.goalWork.findFirstOrThrow({
      where: { id: item.id, organizationId: seeded.organizationId },
    })
    assert.equal(after.disposition, 'used')
    assert.ok(after.dispositionAt, 'dispositionAt must be stamped')
    assert.equal(after.dispositionBy, seeded.userId)
  })

  test('an outcome is refused before anyone used the work, and accepted after', async () => {
    const item = await makeItem({ subjectRef: 'outcome-1' })
    assert.equal(
      (await patch(item.id, { outcome: 'worked' })).status,
      400,
      'nobody has used it yet',
    )

    await patch(item.id, { disposition: 'used' })
    assert.equal((await patch(item.id, { outcome: 'worked' })).status, 200)

    const after = await prisma.goalWork.findFirstOrThrow({
      where: { id: item.id, organizationId: seeded.organizationId },
    })
    assert.equal(after.outcome, 'worked')
    assert.equal(after.outcomeSource, 'human')
    assert.ok(after.outcomeAt)
  })

  test('a skipped item can never be given an outcome or un-skipped', async () => {
    const item = await makeItem({ subjectRef: 'skip-1', disposition: 'skipped' })
    assert.equal((await patch(item.id, { outcome: 'worked' })).status, 400)
    assert.equal((await patch(item.id, { disposition: 'used' })).status, 400)

    const after = await prisma.goalWork.findFirstOrThrow({
      where: { id: item.id, organizationId: seeded.organizationId },
    })
    assert.equal(after.disposition, 'skipped', 'unchanged')
    assert.equal(after.outcome, 'unknown', 'unchanged')
  })

  test('work belonging to another org is not found, not merely empty', async () => {
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const other = await seedTestOrg(prisma)
    const otherGoal = await prisma.goal.create({
      data: {
        organizationId: other.organizationId,
        name: 'Someone else',
        kind: 'kpi',
        unit: 'count',
        direction: 'increase',
        startValue: 0,
        targetValue: 1,
        startAt: new Date('2026-07-01T00:00:00Z'),
        targetDate: new Date('2026-08-01T00:00:00Z'),
        createdByUserId: other.userId,
      },
    })
    const foreign = await prisma.goalWork.create({
      data: {
        organizationId: other.organizationId,
        goalId: otherGoal.id,
        resourceType: 'agent',
        resourceId: 'a',
        subject: 'Theirs',
        produced: 'x',
      },
    })

    // Still authenticated as the FIRST org.
    assert.equal((await patch(foreign.id, { disposition: 'used' })).status, 404)

    await other.cleanup()
    // cleanup() clears the ambient auth context, so re-install ours or every
    // later test in this file runs unauthenticated.
    const { installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    installTestAuth(seeded.auth)
  })

  test('the funnel spans the goal, not the current filter', async () => {
    const { GET } = await import('../[id]/work/route')
    const mine = await (
      await GET(new NextRequest(`http://test/api/goals/${goalId}/work?filter=mine`))
    ).json()
    const all = await (
      await GET(new NextRequest(`http://test/api/goals/${goalId}/work?filter=all`))
    ).json()
    assert.equal(
      mine.stats.overall.produced,
      all.stats.overall.produced,
      'switching tabs must not change the funnel',
    )
  })

  test('a skip note is recorded alongside the other reason', async () => {
    const item = await makeItem({ subjectRef: 'note-1' })
    const response = await patch(item.id, {
      disposition: 'skipped',
      skipReason: 'other',
      skipNote: 'The account merged last week.',
    })
    assert.equal(response.status, 200)

    const after = await prisma.goalWork.findFirstOrThrow({
      where: { id: item.id, organizationId: seeded.organizationId },
    })
    assert.equal(after.skipReason, 'other', 'the enum stays countable')
    assert.equal(after.skipNote, 'The account merged last week.')
  })

  test('revoking a rule retires it as revoked, distinct from evidence killing it', async () => {
    const rule = await prisma.goalWorkRule.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceId: 'agent-1',
        signal: 'daysCold',
        statement: 'Skip cold under 14.',
        skippedCount: 6,
        totalCount: 7,
      },
    })

    const { DELETE } = await import('../[id]/rules/[ruleId]/route')
    const response = await DELETE(
      new NextRequest(`http://test/api/goals/${goalId}/rules/${rule.id}`, { method: 'DELETE' }),
    )
    assert.equal(response.status, 200)

    const after = await prisma.goalWorkRule.findFirstOrThrow({
      where: { id: rule.id, organizationId: seeded.organizationId },
    })
    assert.equal(after.status, 'retired')
    assert.equal(after.retiredReason, 'revoked')
    assert.equal(after.revokedByUserId, seeded.userId, 'who turned it off is recorded')
  })

  test('an already-retired rule cannot be revoked again', async () => {
    const rule = await prisma.goalWorkRule.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceId: 'agent-1',
        signal: 'contacts',
        statement: 'Skip single-contact deals.',
        skippedCount: 6,
        totalCount: 7,
        status: 'retired',
        retiredAt: new Date(),
        retiredReason: 'probes_contradicted',
      },
    })
    const { DELETE } = await import('../[id]/rules/[ruleId]/route')
    const response = await DELETE(
      new NextRequest(`http://test/api/goals/${goalId}/rules/${rule.id}`, { method: 'DELETE' }),
    )
    assert.equal(response.status, 404)

    const after = await prisma.goalWorkRule.findFirstOrThrow({
      where: { id: rule.id, organizationId: seeded.organizationId },
    })
    assert.equal(after.retiredReason, 'probes_contradicted', 'the original reason is preserved')
  })

  test('the work route returns the rules steering this goal', async () => {
    await prisma.goalWorkRule.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceId: 'agent-1',
        signal: 'stage',
        statement: 'Skip prospecting-stage deals.',
        skippedCount: 8,
        totalCount: 9,
      },
    })
    const { GET } = await import('../[id]/work/route')
    const body = await (
      await GET(new NextRequest(`http://test/api/goals/${goalId}/work?filter=all`))
    ).json()
    assert.ok(
      body.rules.some((rule: { statement: string }) => rule.statement === 'Skip prospecting-stage deals.'),
      'active rules must be visible to a person',
    )
  })
}
