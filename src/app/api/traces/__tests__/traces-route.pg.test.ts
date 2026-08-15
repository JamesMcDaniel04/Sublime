/**
 * Route-handler drive for the merged trace stream. Real Postgres + seeded
 * auth (`verify` skill): jsdom cannot prove per-user run visibility, the
 * node_test exclusion, or keyset pagination. Inert without TEST_DATABASE_URL.
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
  let flowId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    // My agent run (visible)
    await prisma.agentExecution.create({
      data: {
        id: 'trace-exec-mine',
        agentType: 'CUSTOM',
        status: 'completed',
        input: {},
        trigger: { type: 'manual' },
        inputTokens: 1000,
        outputTokens: 500,
        userId: seeded.userId,
        organizationId: seeded.organizationId,
        startedAt: new Date('2026-08-14T00:00:03Z'),
        completedAt: new Date('2026-08-14T00:00:33Z'),
      },
    })
    // Another member's agent run (must be invisible)
    const other = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        organizationId: seeded.organizationId,
        isActive: true,
        role: 'MEMBER',
      },
    })
    await prisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        status: 'completed',
        input: {},
        trigger: { type: 'manual' },
        userId: other.id,
        organizationId: seeded.organizationId,
        startedAt: new Date('2026-08-14T00:00:04Z'),
      },
    })
    const flow = await prisma.flow.create({
      data: { name: 'Trace flow', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    flowId = flow.id
    // My flow run (visible). Real runs always stamp a trigger type — and the
    // node_test JSON-path NOT filter drops rows whose trigger lacks the key
    // (missing path → SQL NULL), same as the /api/flows/runs contract.
    await prisma.flowRun.create({
      data: {
        flowId,
        status: 'succeeded',
        trigger: { type: 'manual' },
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        startedAt: new Date('2026-08-14T00:00:02Z'),
        finishedAt: new Date('2026-08-14T00:00:12Z'),
      },
    })
    // Builder single-node test run (excluded by default)
    await prisma.flowRun.create({
      data: {
        flowId,
        status: 'succeeded',
        trigger: { type: 'node_test' },
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        startedAt: new Date('2026-08-14T00:00:05Z'),
      },
    })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const get = async (query = '') => {
    const { GET } = await import('@/app/api/traces/route')
    const response = await GET(new NextRequest(`http://test/api/traces${query}`))
    return { status: response.status, body: await response.json() }
  }

  test('merged list: both kinds, newest first, node_test and other-user runs absent', async () => {
    const { status, body } = await get()
    assert.equal(status, 200)
    assert.deepEqual(
      body.traces.map((t: any) => t.kind),
      ['agent', 'flow'],
    )
    assert.equal(body.traces[0].id, 'trace-exec-mine')
    assert.equal(body.traces[0].tokens.input, 1000)
    assert.equal(body.traces[0].status, 'succeeded')
    assert.ok(body.traces[0].costUsd > 0)
  })

  test('kind and status filters narrow the stream', async () => {
    const { body } = await get('?kind=agent&status=succeeded')
    assert.equal(body.traces.length, 1)
    assert.equal(body.traces[0].kind, 'agent')
    const { body: none } = await get('?kind=agent&status=failed')
    assert.equal(none.traces.length, 0)
  })

  test('cursor pages without repeating or dropping rows', async () => {
    // 30 extra flow runs push the stream past one page.
    for (let index = 0; index < 30; index += 1) {
      await prisma.flowRun.create({
        data: {
          flowId,
          status: 'succeeded',
          trigger: { type: 'schedule' },
          organizationId: seeded.organizationId,
          userId: seeded.userId,
          startedAt: new Date(Date.UTC(2026, 7, 13, 12, 0, index)),
          finishedAt: new Date(Date.UTC(2026, 7, 13, 12, 1, index)),
        },
      })
    }
    const first = await get()
    assert.equal(first.body.traces.length, 25)
    assert.ok(first.body.cursor)
    const second = await get(`?cursor=${encodeURIComponent(first.body.cursor)}`)
    const firstIds = new Set(first.body.traces.map((t: any) => t.id))
    assert.ok(second.body.traces.length >= 7) // 32 visible rows total
    for (const trace of second.body.traces) assert.ok(!firstIds.has(trace.id), 'no repeats across pages')
  })
}
