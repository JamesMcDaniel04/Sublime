/**
 * Route-handler drive for trace detail endpoints. Real Postgres + seeded auth
 * (`verify` skill): proves the 404-not-403 contract, the legacy-payload
 * nullability, and the subagent nesting. Inert without TEST_DATABASE_URL.
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
  let executionId: string
  let flowRunId: string
  let foreignExecutionId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)

    const execution = await prisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        status: 'completed',
        input: {},
        trigger: { type: 'manual' },
        inputTokens: 2000,
        outputTokens: 1000,
        userId: seeded.userId,
        organizationId: seeded.organizationId,
        startedAt: new Date('2026-08-14T01:00:00Z'),
        completedAt: new Date('2026-08-14T01:01:00Z'),
      },
    })
    executionId = execution.id
    // Legacy-shape retrieval event (pre-enrichment: no stages/query/scores)
    await prisma.workflowEvent.create({
      data: {
        executionId,
        kind: 'context.retrieved',
        payload: { source: 'graph-rag', summary: 's', hits: [{ type: 'signal', text: 'x' }], related: [] },
        ts: new Date('2026-08-14T01:00:05Z'),
      },
    })
    await prisma.workflowEvent.create({
      data: {
        executionId,
        kind: 'agent.thinking',
        payload: { text: 'thinking…' },
        ts: new Date('2026-08-14T01:00:10Z'),
      },
    })
    const step = await prisma.workflowStep.create({
      data: {
        executionId,
        node: 'nango:slack.send_message',
        status: 'succeeded',
        input: {},
        startedAt: new Date('2026-08-14T01:00:20Z'),
        completedAt: new Date('2026-08-14T01:00:21Z'),
        createdAt: new Date('2026-08-14T01:00:20Z'),
      },
    })

    const flow = await prisma.flow.create({
      data: { name: 'Detail flow', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const run = await prisma.flowRun.create({
      data: {
        flowId: flow.id,
        status: 'succeeded',
        trigger: { type: 'manual' },
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        startedAt: new Date('2026-08-14T01:00:00Z'),
        finishedAt: new Date('2026-08-14T01:02:00Z'),
      },
    })
    flowRunId = run.id
    const runStep = await prisma.flowRunStep.create({
      data: {
        flowRunId: flowRunId,
        nodeId: 'agent.step',
        agentExecutionId: executionId,
        order: 1,
        status: 'succeeded',
        startedAt: new Date('2026-08-14T01:00:01Z'),
      },
    })
    await prisma.flowSideEffect.create({
      data: {
        organizationId: seeded.organizationId,
        flowRunId,
        flowRunStepId: runStep.id,
        effectKey: `effect-${crypto.randomUUID()}`,
        nodeId: 'agent.step',
        kind: 'tool',
        provider: 'slack',
        operation: 'send_message',
        safety: 'unsafe_write',
        requestHash: 'h',
        status: 'succeeded',
        attempts: 1,
      },
    })
    void step

    // Foreign org execution — must 404 for our caller.
    const foreignOrg = await prisma.organization.create({
      data: { name: 'Other', slug: `other-${crypto.randomUUID()}` },
    })
    const foreignUser = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: foreignOrg.id, isActive: true },
    })
    foreignExecutionId = (
      await prisma.agentExecution.create({
        data: {
          agentType: 'CUSTOM',
          status: 'completed',
          input: {},
          trigger: {},
          userId: foreignUser.id,
          organizationId: foreignOrg.id,
        },
      })
    ).id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const getAgent = async (id: string) => {
    const { GET } = await import('@/app/api/traces/agent/[id]/route')
    const response = await GET(new NextRequest(`http://test/api/traces/agent/${id}`))
    return { status: response.status, body: await response.json() }
  }
  const getFlow = async (id: string) => {
    const { GET } = await import('@/app/api/traces/flow/[id]/route')
    const response = await GET(new NextRequest(`http://test/api/traces/flow/${id}`))
    return { status: response.status, body: await response.json() }
  }

  test('agent detail: spans present, legacy retrieval carries nulls', async () => {
    const { status, body } = await getAgent(executionId)
    assert.equal(status, 200)
    assert.deepEqual(
      body.trace.spans.map((s: any) => s.kind),
      ['retrieval', 'thinking', 'tool'],
    )
    const retrieval = body.trace.spans[0]
    assert.equal(retrieval.stages, null)
    assert.equal(retrieval.query, null)
    assert.equal(retrieval.hits[0].score, null)
    assert.equal(body.trace.summary.hasRetrieval, true)
    assert.ok(body.trace.summary.costUsd > 0)
  })

  test('flow detail: subagent span nests the child trace; effects attach', async () => {
    const { status, body } = await getFlow(flowRunId)
    assert.equal(status, 200)
    const subagent = body.trace.spans.find((s: any) => s.kind === 'subagent')
    assert.ok(subagent, 'subagent span present')
    assert.equal(subagent.trace.summary.id, executionId)
    assert.equal(subagent.trace.spans.length, 3)
    assert.deepEqual(body.trace.summary.tokens, { input: 2000, output: 1000 })
  })

  test('foreign-org and missing ids are 404, never 403', async () => {
    assert.equal((await getAgent(foreignExecutionId)).status, 404)
    assert.equal((await getAgent('nope')).status, 404)
    assert.equal((await getFlow('nope')).status, 404)
  })
}
