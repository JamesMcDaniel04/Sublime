/**
 * A real flow downloading a real binary file.
 *
 * The two properties that define this feature, tested against the actual
 * execution path rather than a model of it:
 *
 *   1. the bytes survive INTACT — the previous behaviour truncated them, so a
 *      downloaded PDF was stored corrupt while the flow reported success;
 *   2. the bytes never reach the run row — base64 in a Postgres JSON column
 *      bloats every record, and the row is what the runs UI loads.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  // Larger than the 50k inline cap, so truncation would be visible.
  const PAYLOAD = Buffer.alloc(120_000, 0xab)

  let prisma: typeof import('@/lib/prisma').prisma
  let dispatchFlowExecution: typeof import('../execute-flow').dispatchFlowExecution
  let binaryStore: typeof import('@/lib/binary/store').binaryStore
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
  let flowId: string
  let realFetch: typeof globalThis.fetch

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ dispatchFlowExecution } = await import('../execute-flow'))
    ;({ binaryStore } = await import('@/lib/binary/store'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)

    const flow = await prisma.flow.create({
      data: {
        name: 'Download a report',
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        trigger: { type: 'manual' },
        graph: {
          nodes: [
            { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
            {
              id: 'get',
              type: 'http',
              data: { label: 'Get report', method: 'GET', url: 'https://example.com/report.pdf', responseType: 'binary' },
            },
          ],
          edges: [{ id: 'e0', source: 'trigger', target: 'get' }],
        },
      },
      select: { id: true },
    })
    flowId = flow.id

    realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array(PAYLOAD), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="quarterly-report.pdf"',
      },
    })) as typeof globalThis.fetch
  })

  after(async () => {
    if (realFetch) globalThis.fetch = realFetch
    if (seeded) await seeded.cleanup()
  })

  test('the run records a handle, not the bytes', async () => {
    const result = await dispatchFlowExecution({
      flowId,
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      input: {},
      trigger: { type: 'manual' },
    } as never)
    assert.ok(!('queued' in result), 'expected an inline run')

    const runs = await prisma.flowRun.findMany({
      where: { flowId, organizationId: seeded.organizationId },
      include: { steps: true },
    })
    const serialized = JSON.stringify(runs)

    // The bytes would appear as a long base64 run of the same character.
    assert.ok(
      !serialized.includes(PAYLOAD.subarray(0, 60).toString('base64')),
      'the file contents were written into the run row',
    )
    // And the row stays small.
    assert.ok(serialized.length < 60_000, `the run row grew to ${serialized.length} bytes`)
  })

  test('the handle describes the file', async () => {
    const step = await prisma.flowRunStep.findFirstOrThrow({
      where: { nodeId: 'get', run: { flowId, organizationId: seeded.organizationId } },
      orderBy: { startedAt: 'desc' },
    })
    const body = (step.output as { body?: Record<string, unknown> } | null)?.body
    assert.ok(body, 'the step recorded no output')
    assert.equal(body.__binary, true, 'the step output was not a binary handle')
    assert.equal(body.size, PAYLOAD.length)
    assert.equal(body.mimeType, 'application/pdf')
    // From Content-Disposition, basename only.
    assert.equal(body.fileName, 'quarterly-report.pdf')
  })

  // The property the old implementation broke.
  test('the stored bytes are byte-identical to what was downloaded', async () => {
    const step = await prisma.flowRunStep.findFirstOrThrow({
      where: { nodeId: 'get', run: { flowId, organizationId: seeded.organizationId } },
      orderBy: { startedAt: 'desc' },
    })
    const id = (step.output as { body?: { id?: string } } | null)?.body?.id
    assert.ok(id, 'the handle carried no id')

    const stored = await binaryStore().get(seeded.organizationId, id)
    assert.ok(stored, 'the bytes were not stored')
    assert.equal(stored.length, PAYLOAD.length, 'the file was truncated')
    assert.ok(stored.equals(PAYLOAD), 'the stored file differs from what was downloaded')
  })

  // The isolation property, at the store rather than only in unit tests.
  test('another workspace cannot read the stored file', async () => {
    const step = await prisma.flowRunStep.findFirstOrThrow({
      where: { nodeId: 'get', run: { flowId, organizationId: seeded.organizationId } },
      orderBy: { startedAt: 'desc' },
    })
    const id = (step.output as { body?: { id?: string } } | null)?.body?.id as string
    assert.equal(await binaryStore().get('some-other-org', id), null)
  })
}
