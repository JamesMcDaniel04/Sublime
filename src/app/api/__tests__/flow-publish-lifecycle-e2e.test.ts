/**
 * Publish lifecycle e2e — the single-writer contract (spec 2026-07-24 §1):
 * publish sets publishedGraph AND status ACTIVE in one transaction;
 * unpublish reverses both; disable parks the flow as DISABLED.
 * Real Postgres (TEST_DATABASE_URL), real module + route handlers, no mocking.
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

  const validGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'transform', data: { fields: [{ name: 'echo', value: 'ok' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't1' }],
  }

  const post = (path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } as never)
  const put = (path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } as never)

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const createFlow = (over: Record<string, unknown> = {}) =>
    prisma.flow.create({
      data: { name: 'Lifecycle QA', organizationId, userId, trigger: { type: 'manual' }, graph: validGraph, ...over },
    })

  test('publishFlowDraft sets publishedGraph, ACTIVE, version+1, and a FlowVersion row', async () => {
    const { publishFlowDraft } = await import('@/lib/flows/publish')
    const flow = await createFlow()
    const result = await publishFlowDraft(flow.id, organizationId, userId)
    assert.deepEqual(result, { published: true, version: 2 })

    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal(row.status, 'ACTIVE', 'publish must set status — the defect this spec exists for')
    assert.ok(row.publishedGraph, 'publishedGraph must be set')
    assert.equal(row.version, 2)
    const snapshot = await prisma.flowVersion.findFirst({ where: { flowId: flow.id, organizationId, version: 2 } })
    assert.ok(snapshot, 'FlowVersion row must exist at the new number')
    assert.equal(snapshot.publishedBy, userId)
  })

  test('publishFlowDraft on an invalid graph returns a reason and mutates nothing', async () => {
    const { publishFlowDraft } = await import('@/lib/flows/publish')
    // An agent step pointing at a nonexistent agent fails validateFlowGraph.
    const badGraph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'a1', type: 'agent', data: { agentId: 'agt_does_not_exist' } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
    }
    const flow = await createFlow({ graph: badGraph })
    const result = await publishFlowDraft(flow.id, organizationId, userId)
    assert.equal(result.published, false)
    assert.ok((result as { reason: string }).reason.length > 0)
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal(row.status, 'DRAFT')
    assert.equal(row.publishedGraph, null)
    assert.equal(row.version, 1)
  })

  test('unpublishFlow nulls publishedGraph, sets DRAFT, keeps version + history', async () => {
    const { publishFlowDraft, unpublishFlow } = await import('@/lib/flows/publish')
    const flow = await createFlow()
    await publishFlowDraft(flow.id, organizationId, userId)
    const result = await unpublishFlow(flow.id, organizationId, userId)
    assert.deepEqual(result, { unpublished: true })
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal(row.status, 'DRAFT')
    assert.equal(row.publishedGraph, null)
    assert.equal(row.version, 2, 'version counter must survive unpublish')
    assert.ok(await prisma.flowVersion.findFirst({ where: { flowId: flow.id, organizationId, version: 2 } }), 'history must survive')
  })

  test('unpublish on a never-published flow is an error; disable is allowed', async () => {
    const { unpublishFlow } = await import('@/lib/flows/publish')
    const flow = await createFlow()
    const bad = await unpublishFlow(flow.id, organizationId, userId)
    assert.equal(bad.unpublished, false)
    const disabled = await unpublishFlow(flow.id, organizationId, userId, { disable: true })
    assert.deepEqual(disabled, { unpublished: true })
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal(row.status, 'DISABLED')
  })

  test('publish → unpublish → publish continues the version sequence (no unique violation)', async () => {
    const { publishFlowDraft, unpublishFlow } = await import('@/lib/flows/publish')
    const flow = await createFlow()
    await publishFlowDraft(flow.id, organizationId, userId)
    await unpublishFlow(flow.id, organizationId, userId)
    const again = await publishFlowDraft(flow.id, organizationId, userId)
    assert.deepEqual(again, { published: true, version: 3 })
  })

  test('route: publish then unpublish round-trips through serializeFlow', async () => {
    const route = await import('../flows/[id]/publish/route')
    const flow = await createFlow()
    const published = await route.POST(post(`/api/flows/${flow.id}/publish`, {}))
    assert.equal(published.status, 200)
    const pubBody = await published.json()
    assert.equal(pubBody.flow.published, true)
    assert.equal(pubBody.flow.status, 'active')

    const unpublished = await route.POST(post(`/api/flows/${flow.id}/publish`, { unpublish: true }))
    assert.equal(unpublished.status, 200)
    const unBody = await unpublished.json()
    assert.equal(unBody.flow.published, false)
    assert.equal(unBody.flow.status, 'draft')
  })

  test('route: disable parks the flow as disabled', async () => {
    const route = await import('../flows/[id]/publish/route')
    const flow = await createFlow()
    const res = await route.POST(post(`/api/flows/${flow.id}/publish`, { disable: true }))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).flow.status, 'disabled')
  })

  test('route: two modes at once is a 400', async () => {
    const route = await import('../flows/[id]/publish/route')
    const flow = await createFlow()
    const res = await route.POST(post(`/api/flows/${flow.id}/publish`, { unpublish: true, disable: true }))
    assert.equal(res.status, 400)
  })

  test('PUT /api/flows ignores a status field (the third writer is closed)', async () => {
    const flows = await import('../flows/route')
    const flow = await createFlow()
    // An older client's save payload: real fields plus the now-ignored status.
    const res = await flows.PUT(put('/api/flows', { id: flow.id, name: 'Lifecycle QA v2', status: 'ACTIVE' }))
    assert.equal(res.status, 200, 'older clients keep saving successfully')
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal(row.name, 'Lifecycle QA v2', 'the rest of the save still lands')
    assert.equal(row.status, 'DRAFT', 'status must not move through PUT')
  })

  test('activateFlow still works as a wrapper (template-provisioning contract)', async () => {
    const { activateFlow } = await import('@/lib/flows/activate')
    const flow = await createFlow()
    const result = await activateFlow(flow.id, organizationId, userId)
    assert.deepEqual(result, { activated: true })
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal(row.status, 'ACTIVE')
    assert.ok(row.publishedGraph)
  })
} else {
  test('flow publish lifecycle e2e (skipped: TEST_DATABASE_URL not set)', () => {})
}
