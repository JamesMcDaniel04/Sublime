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

  // Tool names are flowToolSlug(flow.name) — assert on those, not on flow ids
  // (ids are not guaranteed to appear in a serialized group).
  const toolNames = async () => {
    const { loadFlowPlaneGroups } = await import('@/features/agents/tool-planes')
    const groups = await loadFlowPlaneGroups(organizationId, userId)
    return groups.flatMap((group: { tools: { name: string }[] }) => group.tools.map((tool) => tool.name))
  }
  const slugOf = async (name: string) => {
    const { flowToolSlug } = await import('@/lib/flows/flow-tool')
    return flowToolSlug(name)
  }

  test('tool-planes: a published flow is offered with allowFlows and NO flowIds (defect-1 regression)', async () => {
    const { publishFlowDraft } = await import('@/lib/flows/publish')
    const flow = await createFlow({ name: 'Planes QA Alpha' })
    await publishFlowDraft(flow.id, organizationId, userId)
    assert.ok((await toolNames()).includes(await slugOf('Planes QA Alpha')),
      'published flow must appear without any metadata flag')
  })

  test("tool-planes: another user's private flow is NOT offered; org-shared is", async () => {
    const { publishFlowDraft } = await import('@/lib/flows/publish')
    const stranger = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true },
    })
    const privateFlow = await createFlow({ name: 'Planes QA Private', userId: stranger.id })
    const sharedFlow = await createFlow({ name: 'Planes QA Shared', userId: stranger.id, visibility: 'org_viewer' })
    await publishFlowDraft(privateFlow.id, organizationId, stranger.id)
    await publishFlowDraft(sharedFlow.id, organizationId, stranger.id)

    const names = await toolNames()
    assert.equal(names.includes(await slugOf('Planes QA Private')), false, 'private flow of another user must not leak')
    assert.equal(names.includes(await slugOf('Planes QA Shared')), true, 'org-shared flow must be offered')
  })

  test('tool-planes: an unpublished flow is not offered', async () => {
    await createFlow({ name: 'Planes QA Draft' })
    assert.equal((await toolNames()).includes(await slugOf('Planes QA Draft')), false)
  })

  test('export: non-owner gets 403 for includeCredentials, 200 for sanitized', async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'qa-test-key'
    const route = await import('../flows/[id]/export/route')
    const owner = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true } })
    const flow = await createFlow({ name: 'Export QA', userId: owner.id, visibility: 'org_viewer' })

    // Caller is the seeded (non-owner) user.
    const denied = await route.POST(post(`/api/flows/${flow.id}/export`, { target: 'portable', includeCredentials: true }))
    assert.equal(denied.status, 403)
    const allowed = await route.POST(post(`/api/flows/${flow.id}/export`, { target: 'portable' }))
    assert.equal(allowed.status, 200)
    const doc = await allowed.json()
    assert.equal('credentials' in doc, false)
  })

  test('export: owner with a webhook flow gets a working secret; re-export returns the SAME one', async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'qa-test-key'
    const route = await import('../flows/[id]/export/route')
    const webhookGraph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
        { id: 't1', type: 'transform', data: { fields: [{ name: 'echo', value: 'ok' }] } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 't1' }],
    }
    const flow = await createFlow({ name: 'Export Secret QA', graph: webhookGraph, trigger: { type: 'webhook' } })

    const first = await route.POST(post(`/api/flows/${flow.id}/export`, { target: 'portable', includeCredentials: true }))
    assert.equal(first.status, 200)
    const doc1 = await first.json()
    assert.equal(doc1.containsCredentials, true)
    const secret1 = doc1.credentials?.triggerSecret
    assert.ok(secret1, 'a webhook flow must get a minted secret')

    const second = await route.POST(post(`/api/flows/${flow.id}/export`, { target: 'portable', includeCredentials: true }))
    const doc2 = await second.json()
    assert.equal(doc2.credentials?.triggerSecret, secret1, 'export must not rotate an existing secret')

    // The stored hash validates the exported plaintext.
    const { hashToken } = await import('@/lib/crypto/secrets')
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal((row.trigger as { webhookSecretHash?: string }).webhookSecretHash, hashToken(secret1))
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
