import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  const ids: Record<string, string> = {}
  const otherIds: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))

    const org = await prisma.organization.create({ data: { name: 'Cascade Org', slug: `cascade-${Date.now()}` } })
    ids.org = org.id

    const flow = await prisma.flow.create({
      data: { name: 'cascade-flow', organizationId: org.id, status: 'ACTIVE', graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id

    const flowVersion = await prisma.flowVersion.create({
      data: { flowId: flow.id, organizationId: org.id, version: 1, graph: { nodes: [], edges: [] }, trigger: {} },
    })
    ids.flowVersion = flowVersion.id

    const flowRun = await prisma.flowRun.create({
      data: { flowId: flow.id, organizationId: org.id, status: 'running' },
    })
    ids.flowRun = flowRun.id

    const flowRunStep = await prisma.flowRunStep.create({
      data: { flowRunId: flowRun.id, nodeId: 'n1', status: 'running' },
    })
    ids.flowRunStep = flowRunStep.id

    const pushSubscription = await prisma.pushSubscription.create({
      data: {
        userId: 'user-1',
        organizationId: org.id,
        endpoint: `https://push.example.com/${Date.now()}`,
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      },
    })
    ids.pushSubscription = pushSubscription.id

    const knowledgeDocument = await prisma.knowledgeDocument.create({
      data: {
        organizationId: org.id,
        filename: 'cascade-doc.txt',
        mimeType: 'text/plain',
      },
    })
    ids.knowledgeDocument = knowledgeDocument.id

    const knowledgeChunk = await prisma.knowledgeChunk.create({
      data: {
        documentId: knowledgeDocument.id,
        organizationId: org.id,
        ordinal: 0,
        content: 'cascade chunk content',
      },
    })
    ids.knowledgeChunk = knowledgeChunk.id

    const sharedSkill = await prisma.sharedSkill.create({
      data: {
        name: 'cascade-skill',
        instructions: 'Do the cascade thing.',
        organizationId: org.id,
      },
    })
    ids.sharedSkill = sharedSkill.id

    // Unrelated org — must survive the delete below (no over-delete).
    const otherOrg = await prisma.organization.create({ data: { name: 'Other Org', slug: `other-${Date.now()}` } })
    otherIds.org = otherOrg.id
    const otherFlow = await prisma.flow.create({
      data: { name: 'other-flow', organizationId: otherOrg.id, status: 'ACTIVE', graph: { nodes: [], edges: [] } },
    })
    otherIds.flow = otherFlow.id
  })

  after(async () => {
    // Best-effort cleanup in case the cascade under test didn't run (RED phase).
    await prisma.flowRunStep.deleteMany({ where: { flowRunId: ids.flowRun } }).catch(() => {})
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.flowVersion.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.pushSubscription.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.knowledgeChunk.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.knowledgeDocument.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.sharedSkill.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.organization.deleteMany({ where: { id: ids.org } }).catch(() => {})
    await prisma.flow.deleteMany({ where: { organizationId: otherIds.org } }).catch(() => {})
    await prisma.organization.deleteMany({ where: { id: otherIds.org } }).catch(() => {})
  })

  test('deleting an organization cascades every child chain rooted on it', async () => {
    await prisma.organization.delete({ where: { id: ids.org } })

    const flow = await prisma.flow.findUnique({ where: { id: ids.flow, organizationId: ids.org } })
    assert.equal(flow, null)

    const flowVersion = await prisma.flowVersion.findUnique({ where: { id: ids.flowVersion, organizationId: ids.org } })
    assert.equal(flowVersion, null)

    const flowRunCount = await prisma.flowRun.count({ where: { id: ids.flowRun, organizationId: ids.org } })
    assert.equal(flowRunCount, 0)

    // FlowRunStep has no organizationId column — it is unguarded; look it up directly.
    const flowRunStep = await prisma.flowRunStep.findUnique({ where: { id: ids.flowRunStep } })
    assert.equal(flowRunStep, null)

    const pushSubscriptionCount = await prisma.pushSubscription.count({
      where: { id: ids.pushSubscription, organizationId: ids.org },
    })
    assert.equal(pushSubscriptionCount, 0)

    const knowledgeDocument = await prisma.knowledgeDocument.findUnique({
      where: { id: ids.knowledgeDocument, organizationId: ids.org },
    })
    assert.equal(knowledgeDocument, null)

    const knowledgeChunk = await prisma.knowledgeChunk.findUnique({
      where: { id: ids.knowledgeChunk, organizationId: ids.org },
    })
    assert.equal(knowledgeChunk, null)

    const sharedSkill = await prisma.sharedSkill.findUnique({ where: { id: ids.sharedSkill, organizationId: ids.org } })
    assert.equal(sharedSkill, null)

    // No over-delete: the unrelated org and its flow survive.
    const otherOrg = await prisma.organization.findUnique({ where: { id: otherIds.org } })
    assert.ok(otherOrg)
    const otherFlow = await prisma.flow.findUnique({ where: { id: otherIds.flow, organizationId: otherIds.org } })
    assert.ok(otherFlow)
  })
}
