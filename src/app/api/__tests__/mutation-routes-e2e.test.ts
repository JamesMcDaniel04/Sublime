/**
 * End-to-end drive of high-risk MUTATION routes, following the route-smoke
 * protocol: real Postgres (TEST_DATABASE_URL), seeded auth, REAL route
 * handlers called with NextRequest objects.
 *
 * These are the first entries burned down from mutation-coverage.test.ts's
 * PENDING_COVERAGE list. They are deliberately NOT smoke cases: a mutation
 * that returns 200 and writes nothing is exactly as broken as one that 500s,
 * so every case here asserts the effect on the database, not the status code.
 *
 * Chosen for consequence rather than convenience — secret minting (a security
 * boundary where the plaintext must never be re-readable) and CSV import (the
 * ingestion path, where wrong data is worse than no data).
 *
 * Skipped entirely unless TEST_DATABASE_URL is set (mirrors route-smoke).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let installTestAuth: (auth: any) => void
  let makeTestAuthContext: (auth: any) => any

  const json = (path: string, method: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    } as never)

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const { seedTestOrg } = testAuth
    installTestAuth = testAuth.installTestAuth
    makeTestAuthContext = testAuth.makeTestAuthContext
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const makeAgent = () =>
    prisma.agentTask.create({
      data: {
        description: 'Trigger secret agent',
        objective: 'o',
        status: 'ACTIVE',
        agentType: 'assistant',
        organizationId,
        userId,
      },
    })

  const metadataOf = async (agentId: string) => {
    const row = await prisma.agentTask.findFirst({ where: { id: agentId, organizationId } })
    return (row.metadata ?? {}) as Record<string, unknown>
  }

  // ── agents/[id]/trigger-secret#POST ────────────────────────────────────

  test('minting a trigger secret returns the plaintext once and stores only a hash', async () => {
    const agent = await makeAgent()
    const { POST } = await import('../agents/[id]/trigger-secret/route')

    const res = await POST(json(`/api/agents/${agent.id}/trigger-secret`, 'POST', {}))
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()
    assert.equal(body.hasSecret, true)
    assert.ok(typeof body.secret === 'string' && body.secret.length > 0, 'plaintext returned at mint')

    const metadata = await metadataOf(agent.id)
    assert.ok(typeof metadata.triggerSecretHash === 'string', 'hash persisted')
    // The security property: the plaintext must never be sitting in metadata
    // under the legacy key, and the stored hash must not equal it.
    assert.equal(metadata.triggerSecret, undefined, 'plaintext must never be stored')
    assert.notEqual(metadata.triggerSecretHash, body.secret, 'stored value must be a hash, not the secret')
  })

  test('a second call never re-reveals the secret', async () => {
    const agent = await makeAgent()
    const { POST } = await import('../agents/[id]/trigger-secret/route')

    const first = await (await POST(json(`/api/agents/${agent.id}/trigger-secret`, 'POST', {}))).json()
    const second = await (await POST(json(`/api/agents/${agent.id}/trigger-secret`, 'POST', {}))).json()

    assert.ok(first.secret, 'first call mints')
    assert.equal(second.hasSecret, true)
    assert.equal(second.secret, null, 'an existing secret is never readable again')
    // …and the stored hash is untouched, i.e. the existing secret still works.
    const metadata = await metadataOf(agent.id)
    assert.equal(metadata.triggerSecretHash, (await metadataOf(agent.id)).triggerSecretHash)
  })

  test('rotating invalidates the old secret and issues a different one', async () => {
    const agent = await makeAgent()
    const { POST } = await import('../agents/[id]/trigger-secret/route')

    const first = await (await POST(json(`/api/agents/${agent.id}/trigger-secret`, 'POST', {}))).json()
    const hashBefore = (await metadataOf(agent.id)).triggerSecretHash
    const rotated = await (await POST(json(`/api/agents/${agent.id}/trigger-secret`, 'POST', { rotate: true }))).json()
    const hashAfter = (await metadataOf(agent.id)).triggerSecretHash

    assert.ok(rotated.secret, 'rotation returns a new plaintext')
    assert.notEqual(rotated.secret, first.secret, 'rotation must not reissue the same secret')
    assert.notEqual(hashAfter, hashBefore, 'the old secret must stop validating')
  })

  test("another organization's agent is not found", async () => {
    const other = await prisma.organization.create({
      data: { name: 'Other', slug: `other-${crypto.randomUUID()}` },
    })
    try {
      const otherUser = await prisma.user.create({
        data: { supabaseId: crypto.randomUUID(), organizationId: other.id, isActive: true },
      })
      const foreign = await prisma.agentTask.create({
        data: {
          description: 'Foreign agent', objective: 'o', status: 'ACTIVE', agentType: 'assistant',
          organizationId: other.id, userId: otherUser.id,
        },
      })
      const { POST } = await import('../agents/[id]/trigger-secret/route')
      const res = await POST(json(`/api/agents/${foreign.id}/trigger-secret`, 'POST', {}))
      assert.equal(res.status, 404, 'a cross-tenant id must 404, never mint')

      const metadata = (await prisma.agentTask.findFirst({ where: { id: foreign.id, organizationId: other.id } })).metadata
      assert.equal(metadata, null, 'no secret may be written to another tenant’s agent')
    } finally {
      await prisma.organization.delete({ where: { id: other.id } }).catch(() => {})
    }
  })

  // ── goals/[id]/datapoints/import#POST ──────────────────────────────────

  const makeGoalWithMetric = async () => {
    const goal = await prisma.goal.create({
      data: {
        organizationId,
        name: 'Import target',
        kind: 'arr',
        direction: 'increase',
        unit: 'usd',
        startValue: 0,
        targetValue: 1000,
        startAt: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-12-31T00:00:00Z'),
        createdByUserId: userId,
        metrics: {
          create: {
            organizationId,
            source: 'manual',
            metricKey: 'manual.arr',
            role: 'primary',
            refreshIntervalHours: 24,
          },
        },
      },
      include: { metrics: true },
    })
    return { goalId: goal.id, metricId: goal.metrics[0].id }
  }

  const importCsv = async (goalId: string, csv: string) => {
    const { POST } = await import('../goals/[id]/datapoints/import/route')
    return POST(json(`/api/goals/${goalId}/datapoints/import`, 'POST', csv))
  }

  test('CSV import persists rows as backfill and records the capture event', async () => {
    const { goalId, metricId } = await makeGoalWithMetric()
    const res = await importCsv(goalId, '2026-02-01,100\n2026-02-02,150\n')
    assert.equal(res.status, 200, await res.clone().text())
    assert.equal((await res.json()).imported, 2)

    const points = await prisma.metricDatapoint.findMany({
      where: { organizationId, goalMetricId: metricId },
      orderBy: { capturedAt: 'asc' },
    })
    assert.deepEqual(points.map((p: any) => p.value), [100, 150])
    assert.deepEqual([...new Set(points.map((p: any) => p.origin))], ['backfill'])

    const event = await prisma.userEvent.findFirst({
      where: { organizationId, userId, kind: 'goal_datapoints_imported', resourceId: goalId },
    })
    assert.ok(event, 'import must be captured in the behavior ledger')
    assert.equal((event.context as any).imported, 2)
  })

  test('malformed rows are skipped by line without discarding the valid ones', async () => {
    const { goalId, metricId } = await makeGoalWithMetric()
    const res = await importCsv(goalId, '2026-03-01,10\nnot-a-date,20\n2026-03-03,30\n')
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()

    assert.equal(body.imported, 2, 'the valid remainder must still import')
    assert.equal(body.skipped.length, 1)
    assert.equal(body.skipped[0].line, 2, 'the skip is reported by source line number')

    const count = await prisma.metricDatapoint.count({ where: { organizationId, goalMetricId: metricId } })
    assert.equal(count, 2)
  })

  test('re-importing the same day updates in place rather than duplicating', async () => {
    const { goalId, metricId } = await makeGoalWithMetric()
    await importCsv(goalId, '2026-04-01,10\n')
    const res = await importCsv(goalId, '2026-04-01,99\n')
    assert.equal(res.status, 200, await res.clone().text())

    const points = await prisma.metricDatapoint.findMany({ where: { organizationId, goalMetricId: metricId } })
    assert.equal(points.length, 1, 'the same bucket must upsert, not accumulate')
    assert.equal(points[0].value, 99)
  })

  test('an empty CSV is refused and writes nothing', async () => {
    const { goalId, metricId } = await makeGoalWithMetric()
    const res = await importCsv(goalId, '   \n')
    assert.equal(res.status, 400)
    assert.equal(await prisma.metricDatapoint.count({ where: { organizationId, goalMetricId: metricId } }), 0)
  })

  test('a goal with no primary metric is refused with a distinct code', async () => {
    // Distinct from "goal not found": the caller can act on this one.
    const goal = await prisma.goal.create({
      data: {
        organizationId, name: 'No metric', kind: 'arr', direction: 'increase', unit: 'usd',
        startValue: 0, targetValue: 10, startAt: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-12-31T00:00:00Z'), createdByUserId: userId,
      },
    })
    const res = await importCsv(goal.id, '2026-05-01,10\n')
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, 'METRIC_NOT_FOUND')
  })

  // ── agents/[id]/runs/[runId]#POST/#DELETE ──────────────────────────────

  const makeRun = async (status: string) => {
    const agent = await prisma.agentTask.create({
      data: {
        description: 'Shared definition, private runs',
        objective: 'o',
        status: 'ACTIVE',
        agentType: 'assistant',
        visibility: 'org_viewer',
        organizationId,
        userId,
      },
    })
    const run = await prisma.agentExecution.create({
      data: {
        agentType: 'assistant',
        agentTaskId: agent.id,
        status,
        input: {},
        trigger: { type: 'manual' },
        organizationId,
        userId,
      },
    })
    return { agent, run }
  }

  test('a run owner can cancel an active run and delete a finished run', async () => {
    installTestAuth(seeded.auth)
    const { POST, DELETE } = await import('../agents/[id]/runs/[runId]/route')
    const active = await makeRun('running')
    const cancelled = await POST(json(`/api/agents/${active.agent.id}/runs/${active.run.id}`, 'POST', { action: 'cancel' }))
    assert.equal(cancelled.status, 200, await cancelled.clone().text())
    assert.equal((await prisma.agentExecution.findUnique({ where: { id: active.run.id } }))?.status, 'cancelling')

    const finished = await makeRun('completed')
    const deleted = await DELETE(new NextRequest(new URL(`http://test/api/agents/${finished.agent.id}/runs/${finished.run.id}`), { method: 'DELETE' }) as never)
    assert.equal(deleted.status, 200, await deleted.clone().text())
    assert.equal(await prisma.agentExecution.findUnique({ where: { id: finished.run.id } }), null)
  })

  test('sharing an agent never lets a same-org user cancel or delete its owner\'s run', async () => {
    const otherUser = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true, role: 'MEMBER' },
    })
    installTestAuth(makeTestAuthContext({
      organizationId,
      userId: otherUser.supabaseId,
      dbUser: otherUser,
      user: { id: otherUser.supabaseId },
      role: 'MEMBER',
    }))
    const { POST, DELETE } = await import('../agents/[id]/runs/[runId]/route')
    const active = await makeRun('running')
    const finished = await makeRun('completed')
    try {
      const cancel = await POST(json(`/api/agents/${active.agent.id}/runs/${active.run.id}`, 'POST', { action: 'cancel' }))
      assert.equal(cancel.status, 404)
      const remove = await DELETE(new NextRequest(new URL(`http://test/api/agents/${finished.agent.id}/runs/${finished.run.id}`), { method: 'DELETE' }) as never)
      assert.equal(remove.status, 404)
      assert.equal((await prisma.agentExecution.findUnique({ where: { id: active.run.id } }))?.status, 'running')
      assert.ok(await prisma.agentExecution.findUnique({ where: { id: finished.run.id } }))
    } finally {
      installTestAuth(seeded.auth)
    }
  })
}
