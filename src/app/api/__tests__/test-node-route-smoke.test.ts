/**
 * Route smoke: /api/flows/[id]/test-node + /api/flows/[id]/pins against a real
 * Postgres. The load-bearing assertion is the write-safety one: a node test
 * creates exactly ONE step row — nothing downstream ever executed.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let flowId: string

  // transform nodes rather than http/tool: the assertions are about WHICH
  // nodes ran, not what they returned, and transforms need no network stub.
  const GRAPH = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'a', type: 'transform', data: { label: 'Set fields', fields: [{ name: 'x', value: 'one' }] } },
      { id: 'b', type: 'transform', data: { label: 'Set more', fields: [{ name: 'y', value: 'two' }] } },
      { id: 'loop', type: 'loop', data: { label: 'For each', over: '{{trigger.input.items}}', body: [] } },
      // A deliberately broken step: single-node tests of OTHER nodes must not
      // be blocked by this one's validation error.
      { id: 'broken', type: 'transform', data: { label: 'Unfinished', fields: [] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
    ],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const flow = await prisma.flow.create({
      data: { name: 'Node test smoke', organizationId: seeded.organizationId, userId: seeded.userId, graph: GRAPH, trigger: { type: 'manual' } },
      select: { id: true },
    })
    flowId = flow.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const postTestNode = async (body: unknown) => {
    const { POST } = await import('@/app/api/flows/[id]/test-node/route')
    return POST(new NextRequest(new URL(`http://test/api/flows/${flowId}/test-node`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never)
  }

  test('runs only the selected node and tags the run node_test', async () => {
    const response = await postTestNode({ nodeId: 'a', input: {} })
    assert.equal(response.status, 200)
    const runs = await prisma.flowRun.findMany({
      where: { flowId, organizationId: seeded.organizationId },
      include: { steps: true },
    })
    assert.equal(runs.length, 1)
    // The whole point: one step row, and it is the node we asked for.
    assert.deepEqual(runs[0].steps.map((step: { nodeId: string }) => step.nodeId), ['a'])
    assert.equal(runs[0].trigger.type, 'node_test')
    assert.equal(runs[0].status, 'succeeded')
  })

  test('a broken UNRELATED step does not block testing this one', async () => {
    // 'broken' fails validation (EMPTY_TRANSFORM); a full run would be
    // rejected. Testing 'b' must still work — removing "fix the whole flow
    // before you can test anything" is what this mode is for.
    const response = await postTestNode({ nodeId: 'b', mockOutputs: { a: { x: 'one' } } })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.run.status, 'succeeded')
  })

  test('testing the broken step itself reports ITS validation error', async () => {
    const response = await postTestNode({ nodeId: 'broken', input: {} })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /field/i)
  })

  test('a node-test run is absent from the default runs list', async () => {
    const { GET } = await import('@/app/api/flows/[id]/runs/route')
    const hidden = await GET(new NextRequest(new URL(`http://test/api/flows/${flowId}/runs`)) as never)
    const shown = await GET(new NextRequest(new URL(`http://test/api/flows/${flowId}/runs?includeNodeTests=1`)) as never)
    const hiddenRuns = (await hidden.json()).runs
    const shownRuns = (await shown.json()).runs
    assert.equal(hiddenRuns.length, 0, 'builder experiments must not pollute run history')
    assert.ok(shownRuns.length >= 2, 'but must remain retrievable when asked for')
  })

  test('a container node is refused', async () => {
    const response = await postTestNode({ nodeId: 'loop', input: {} })
    assert.notEqual(response.status, 200)
    assert.match(JSON.stringify(await response.json()), /steps inside it/i)
  })

  test('pins round-trip: PUT → GET → DELETE, per user', async () => {
    const { GET, PUT, DELETE } = await import('@/app/api/flows/[id]/pins/route')
    const url = `http://test/api/flows/${flowId}/pins`
    const put = await PUT(new NextRequest(new URL(url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'a', output: { x: 'pinned' } }),
    }) as never)
    assert.equal(put.status, 200)
    const listed = await (await GET(new NextRequest(new URL(url)) as never)).json()
    assert.deepEqual(listed.pins.map((pin: { nodeId: string }) => pin.nodeId), ['a'])
    assert.deepEqual(listed.pins[0].output, { x: 'pinned' })
    const del = await DELETE(new NextRequest(new URL(url), {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'a' }),
    }) as never)
    assert.equal(del.status, 200)
    const after = await (await GET(new NextRequest(new URL(url)) as never)).json()
    assert.deepEqual(after.pins, [])
  })

  test('another org cannot test a node or read pins of this flow', async () => {
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const other = await seedTestOrg(prisma)
    installTestAuth(other.auth)
    try {
      const testResponse = await postTestNode({ nodeId: 'a', input: {} })
      // 404, not 403 — a cross-org id must not confirm the flow exists.
      assert.equal(testResponse.status, 404)
      const { GET } = await import('@/app/api/flows/[id]/pins/route')
      const pinsResponse = await GET(new NextRequest(new URL(`http://test/api/flows/${flowId}/pins`)) as never)
      assert.equal(pinsResponse.status, 404)
    } finally {
      installTestAuth(seeded.auth)
      await other.cleanup()
    }
  })
}
