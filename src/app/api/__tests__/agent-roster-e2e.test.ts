/**
 * End-to-end drive of the agent roster surfaces: workers (the person-shaped
 * tiles a group of agents works under), their KPI aggregate, and role-label
 * generation.
 *
 * Follows the route-smoke protocol: real Postgres (TEST_DATABASE_URL), seeded
 * auth, REAL route handlers called with NextRequest objects. Every case asserts
 * the effect on the database or the computed number — a mutation that returns
 * 200 and writes nothing is exactly as broken as one that 500s.
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

  const json = (path: string, method: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    } as never)

  const get = (path: string) => new NextRequest(new URL(`http://test${path}`))

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    seeded = await testAuth.seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const makeAgent = (overrides: Record<string, unknown> = {}) =>
    prisma.agentTask.create({
      data: {
        description: 'Roster agent',
        objective: 'Do the work',
        status: 'ACTIVE',
        agentType: 'CUSTOM',
        visibility: 'private',
        organizationId,
        userId,
        ...overrides,
      },
    })

  const agentRow = (id: string) => prisma.agentTask.findFirst({ where: { id, organizationId } })

  /**
   * /api/agents/stats is cached 60s per org+user, so a cache warmed by an
   * earlier case would hide an agent created by a later one. Harmless in
   * production — a just-hired agent has no runs to show either way — but tests
   * must not depend on the order they run in.
   */
  const freshStats = async () => {
    const { cacheDelete } = await import('@/lib/cache')
    await cacheDelete(`agents:stats:${organizationId}:${userId}`)
    const { GET } = await import('../agents/stats/route')
    return (await GET(get('/api/agents/stats'))).json()
  }

  const makeRun = (agentTaskId: string, status: string, runUserId = userId) =>
    prisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        agentTaskId,
        status,
        input: {},
        trigger: { type: 'manual' },
        organizationId,
        userId: runUserId,
      },
    })

  // ── workers#POST ─────────────────────────────────────────────────────────

  test('hiring a worker files the given agents under it', async () => {
    const [first, second] = await Promise.all([makeAgent(), makeAgent()])
    const { POST } = await import('../workers/route')

    const res = await POST(json('/api/workers', 'POST', { name: 'Dana', agentIds: [first.id, second.id] }))
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()

    assert.equal((await agentRow(first.id)).workerId, body.worker.id, 'agent joined the worker')
    assert.equal((await agentRow(second.id)).workerId, body.worker.id)
  })

  // Worker membership must never become a side door around agent sharing:
  // filing an agent under a worker is editing that agent.
  test('an agent the caller may not edit cannot be filed under their worker', async () => {
    const stranger = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true, role: 'MEMBER' },
    })
    const theirs = await makeAgent({ userId: stranger.id, visibility: 'private' })
    const { POST } = await import('../workers/route')

    const res = await POST(json('/api/workers', 'POST', { name: 'Poacher', agentIds: [theirs.id] }))
    assert.equal(res.status, 403, 'moving someone else’s private agent is refused')
    assert.equal((await agentRow(theirs.id)).workerId, null, 'and the agent was not moved')
  })

  // ── workers#PUT ──────────────────────────────────────────────────────────

  test('renaming and re-skinning a worker persists both', async () => {
    const { POST, PUT } = await import('../workers/route')
    const created = await (await POST(json('/api/workers', 'POST', { name: 'Before' }))).json()

    const res = await PUT(json('/api/workers', 'PUT', {
      id: created.worker.id, name: 'After', avatarSeed: 'seed-9', roleLabel: 'Pipeline Analyst',
    }))
    assert.equal(res.status, 200, await res.clone().text())

    const row = await prisma.agentWorker.findFirst({ where: { id: created.worker.id, organizationId } })
    assert.equal(row.name, 'After')
    assert.equal(row.avatarSeed, 'seed-9')
    assert.equal(row.roleLabel, 'Pipeline Analyst')
  })

  test('a role label that breaks the one-or-two-word rule is refused, not truncated', async () => {
    const { POST, PUT } = await import('../workers/route')
    const created = await (await POST(json('/api/workers', 'POST', { name: 'Labelled' }))).json()

    const res = await PUT(json('/api/workers', 'PUT', { id: created.worker.id, roleLabel: 'Chief Revenue Officer' }))
    assert.equal(res.status, 400, 'a three-word role is rejected at the boundary')
    const row = await prisma.agentWorker.findFirst({ where: { id: created.worker.id, organizationId } })
    assert.equal(row.roleLabel, null, 'nothing was stored')
  })

  // A stale tab must not be able to detach an agent that has since moved on.
  test('detaching is scoped to the worker that actually holds the agent', async () => {
    const agent = await makeAgent()
    const { POST, PUT } = await import('../workers/route')
    const holder = await (await POST(json('/api/workers', 'POST', { name: 'Holder', agentIds: [agent.id] }))).json()
    const other = await (await POST(json('/api/workers', 'POST', { name: 'Other' }))).json()

    await PUT(json('/api/workers', 'PUT', { id: other.worker.id, removeAgentIds: [agent.id] }))

    assert.equal((await agentRow(agent.id)).workerId, holder.worker.id, 'the real holder still has them')
  })

  // ── workers#DELETE ───────────────────────────────────────────────────────

  // The data-safety property of the ON DELETE SET NULL migration: removing an
  // identity must never destroy the work done under it.
  test('removing a worker keeps its agents and their run history', async () => {
    const agent = await makeAgent()
    await makeRun(agent.id, 'completed')
    const { POST, DELETE } = await import('../workers/route')
    const created = await (await POST(json('/api/workers', 'POST', { name: 'Temp', agentIds: [agent.id] }))).json()

    const res = await DELETE(json('/api/workers', 'DELETE', { id: created.worker.id }))
    assert.equal(res.status, 200, await res.clone().text())

    const survivor = await agentRow(agent.id)
    assert.ok(survivor, 'the agent survives its worker')
    assert.equal(survivor.workerId, null, 'and returns to the roster standalone')
    const runs = await prisma.agentExecution.count({ where: { agentTaskId: agent.id, organizationId } })
    assert.equal(runs, 1, 'run history is untouched')
  })

  // ── agents/stats#GET ─────────────────────────────────────────────────────

  // The reason this route exists: AgentTask.executionCount is incremented both
  // before a scheduled run and after a successful one, so it double-counts.
  test('KPIs come from the run ledger, not the double-counted executionCount', async () => {
    const agent = await makeAgent({ executionCount: 999 })
    await makeRun(agent.id, 'completed')
    await makeRun(agent.id, 'completed')
    await makeRun(agent.id, 'failed')

    const body = await freshStats()
    const kpis = body.stats[agent.id]
    assert.equal(kpis.runs, 2, 'two delivered runs, not 999')
    assert.equal(kpis.failed, 1)
    assert.equal(kpis.successRate, 67)
  })

  test('a run paused for a human is reported as waiting, never as a failure', async () => {
    const agent = await makeAgent()
    await makeRun(agent.id, 'completed')
    await makeRun(agent.id, 'waiting_for_input')

    const body = await freshStats()
    const kpis = body.stats[agent.id]
    assert.equal(kpis.waiting, 1)
    assert.equal(kpis.successRate, 100, 'a pending question is not a defect')
  })

  test('another workspace’s agents never appear in these stats', async () => {
    const otherOrg = await prisma.organization.create({
      data: { name: 'Other', slug: `other-${crypto.randomUUID()}` },
    })
    const otherUser = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: otherOrg.id, isActive: true, role: 'ADMIN' },
    })
    const theirAgent = await prisma.agentTask.create({
      data: {
        description: 'Theirs', objective: 'o', status: 'ACTIVE', agentType: 'CUSTOM',
        organizationId: otherOrg.id, userId: otherUser.id,
      },
    })

    const body = await freshStats()
    assert.equal(body.stats[theirAgent.id], undefined, 'cross-org agent is absent')
    await prisma.organization.delete({ where: { id: otherOrg.id } }).catch(() => {})
  })

  // ── agents/role-labels#POST ──────────────────────────────────────────────

  test('an agent that already has a valid label is never re-generated', async () => {
    const agent = await makeAgent({ metadata: { title: 'Known', roleLabel: 'Invoice Auditor' } })
    const { POST } = await import('../agents/role-labels/route')

    const res = await POST(json('/api/agents/role-labels', 'POST', { agentIds: [agent.id] }))
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()
    assert.deepEqual(body.labels, {}, 'nothing regenerated, so nothing billed')
    assert.equal((await agentRow(agent.id)).metadata.roleLabel, 'Invoice Auditor', 'stored label untouched')
  })

  // Labels are cosmetic: with no model provider the roster must still paint,
  // falling back to the department rather than showing an error.
  test('with no model provider configured the request degrades instead of failing', async () => {
    const keys = ['ANTHROPIC_API_KEY', 'QWEN_API_KEY', 'QWEN_BASE_URL']
    const saved = keys.map((key) => [key, process.env[key]] as const)
    for (const key of keys) delete process.env[key]
    try {
      const agent = await makeAgent({ metadata: { title: 'Unlabelled' } })
      const { POST } = await import('../agents/role-labels/route')

      const res = await POST(json('/api/agents/role-labels', 'POST', { agentIds: [agent.id] }))
      assert.equal(res.status, 200, 'a missing provider is not an error for the page')
      const body = await res.json()
      assert.equal(body.skipped, 'ai_unavailable')
      assert.equal((await agentRow(agent.id)).metadata.roleLabel, undefined, 'nothing was invented')
    } finally {
      for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
    }
  })

  test('labels are never generated for an agent in another workspace', async () => {
    const otherOrg = await prisma.organization.create({
      data: { name: 'Other2', slug: `other2-${crypto.randomUUID()}` },
    })
    const otherUser = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: otherOrg.id, isActive: true, role: 'ADMIN' },
    })
    const theirAgent = await prisma.agentTask.create({
      data: {
        description: 'Theirs', objective: 'o', status: 'ACTIVE', agentType: 'CUSTOM',
        organizationId: otherOrg.id, userId: otherUser.id,
      },
    })
    const { POST } = await import('../agents/role-labels/route')

    const body = await (await POST(json('/api/agents/role-labels', 'POST', { agentIds: [theirAgent.id] }))).json()
    assert.deepEqual(body.labels, {}, 'a cross-org id resolves to nothing')
    await prisma.organization.delete({ where: { id: otherOrg.id } }).catch(() => {})
  })

  // ── workers#GET ──────────────────────────────────────────────────────────

  test('a worker whose only agent is private to someone else stays hidden', async () => {
    const stranger = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true, role: 'MEMBER' },
    })
    const theirAgent = await makeAgent({ userId: stranger.id, visibility: 'private' })
    const worker = await prisma.agentWorker.create({
      data: { organizationId, userId: stranger.id, name: 'Theirs' },
    })
    await prisma.agentTask.updateMany({
      where: { id: theirAgent.id, organizationId },
      data: { workerId: worker.id },
    })
    const { GET } = await import('../workers/route')

    const body = await (await GET(get('/api/workers')))?.json()
    const ids = body.workers.map((entry: { id: string }) => entry.id)
    assert.ok(!ids.includes(worker.id), 'no tile for a worker made only of agents you cannot see')
  })
}
