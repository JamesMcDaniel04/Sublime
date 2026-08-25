/**
 * Evaluation through the real routes.
 *
 * The property that matters: a run records the agent VERSION it evaluated, and
 * the trend compares against the previous run. Without both, a stored score is
 * a number with no referent and nobody can answer "did that change help".
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const req = (method: string, body?: unknown) =>
    new NextRequest(new URL('http://test/api/evals'), {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    } as never)

  test('evaluation routes', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { GET, POST } = await import('../route')
    const { runEvalDataset } = await import('@/features/eval/run-dataset')

    const seeded = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    after(async () => {
      clearTestAuth()
      await seeded.cleanup()
      await other.cleanup()
      await prisma.$disconnect()
    })

    const agent = await prisma.agentTask.create({
      data: {
        description: 'Evaluated agent',
        objective: 'answer well',
        status: 'ACTIVE',
        organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id,
      },
    })

    let datasetId = ''

    await t.test('a dataset can be created for an agent', async () => {
      const body = await (await POST(req('POST', { action: 'createDataset', agentTaskId: agent.id, name: 'Regression set' }))).json()
      assert.equal(body.success, true)
      datasetId = body.dataset.id
    })

    await t.test('a dataset cannot be attached to another workspace agent', async () => {
      installTestAuth(other.auth)
      const response = await POST(req('POST', { action: 'createDataset', agentTaskId: agent.id, name: 'Theft' }))
      assert.equal(response.status, 404)
      installTestAuth(seeded.auth)
    })

    await t.test('cases can be added', async () => {
      const body = await (await POST(req('POST', {
        action: 'addCase', datasetId, input: 'What is the total?', mustContain: ['42'],
      }))).json()
      assert.equal(body.success, true)
    })

    // The load-bearing property.
    await t.test('a run records the agent version it evaluated', async () => {
      const result = await runEvalDataset({
        organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id,
        datasetId,
        execute: async () => 'The total is 42.',
      })
      const run = await prisma.evalRun.findFirstOrThrow({ where: { id: result.runId, organizationId: seeded.auth.organizationId } })
      assert.equal(run.agentVersion, agent.version)
      assert.equal(run.passed, 1)
      assert.equal(run.failed, 0)
    })

    await t.test('an output missing required content fails the case', async () => {
      const result = await runEvalDataset({
        organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id,
        datasetId,
        execute: async () => 'I could not determine the total.',
      })
      assert.equal(result.failed, 1)
    })

    // A crashing case must count as a failure, not vanish.
    await t.test('a case that throws is recorded as a failure, not skipped', async () => {
      const result = await runEvalDataset({
        organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id,
        datasetId,
        execute: async () => { throw new Error('model exploded') },
      })
      assert.equal(result.failed, 1, 'a crashed case shrank the denominator instead of failing')
      const results = await prisma.evalCaseResult.findMany({
        where: { runId: result.runId, organizationId: seeded.auth.organizationId },
      })
      assert.match(results[0]?.notes ?? '', /exploded/)
    })

    await t.test('the listing reports a trend against the previous run', async () => {
      const body = await (await GET(req('GET'))).json()
      const dataset = body.datasets.find((entry: { id: string }) => entry.id === datasetId)
      assert.ok(dataset)
      assert.equal(dataset.caseCount, 1)
      // Last run failed, the one before failed too → unchanged; either way it
      // must be a real verdict rather than undefined.
      assert.ok(['improved', 'regressed', 'unchanged', 'unknown'].includes(dataset.trend))
    })

    await t.test('another workspace sees no datasets', async () => {
      installTestAuth(other.auth)
      const body = await (await GET(req('GET'))).json()
      assert.equal(body.datasets.length, 0)
      installTestAuth(seeded.auth)
    })
  })
} else {
  test('evaluation routes (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
