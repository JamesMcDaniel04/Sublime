import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY

  let prisma: any
  let retrieveAgentMemory: any
  let saveAgentMemory: any
  let vectorReady = false
  const ids: Record<string, string> = {}

  const dims = (fn: (i: number) => number) => Array.from({ length: 1024 }, (_, i) => fn(i))

  let origFetch: typeof fetch
  function stubEmbedding(vector: number[]) {
    origFetch = global.fetch
    process.env.VOYAGE_API_KEY = 'test-key'
    // @ts-expect-error test stub
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: vector, index: 0 }] }) })
  }
  function unstubEmbedding() {
    global.fetch = origFetch
    delete process.env.VOYAGE_API_KEY
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ retrieveAgentMemory, saveAgentMemory } = await import('../agent-memory'))

    const available = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    vectorReady = Array.isArray(available) && available.length > 0
    if (!vectorReady) return

    const org = await prisma.organization.create({ data: { name: 'memory-vector Org', slug: `memory-vector-${Date.now()}` } })
    ids.org = org.id
    const otherOrg = await prisma.organization.create({ data: { name: 'memory-vector other Org', slug: `memory-vector-other-${Date.now()}` } })
    ids.otherOrg = otherOrg.id

    const agent = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'memory-vector test agent', objective: 'test' },
    })
    ids.agent = agent.id

    const otherAgent = await prisma.agentTask.create({
      data: { organizationId: otherOrg.id, description: 'other org agent', objective: 'test' },
    })
    ids.otherAgent = otherAgent.id
  })

  after(async () => {
    if (!vectorReady) return
    await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
    await prisma.organization.delete({ where: { id: ids.otherOrg } }).catch(() => {})
  })

  test('retrieveAgentMemory ranks in-database by cosine distance and respects status=open + org isolation', async () => {
    if (!vectorReady) return

    const near = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'near memory', content: 'near content', status: 'open' },
    })
    const far = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'far memory', content: 'far content', status: 'open' },
    })
    const dismissed = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'dismissed memory', content: 'dismissed content', status: 'dismissed' },
    })
    const otherOrgMemory = await prisma.agentMemory.create({
      data: { organizationId: ids.otherOrg, agentId: ids.otherAgent, kind: 'learning', title: 'other org memory', content: 'other org secret', status: 'open' },
    })

    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${dims((i) => (i === 0 ? 1 : 0.01)).join(',')}]`, near.id)
    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${dims((i) => (i === 0 ? -1 : 0)).join(',')}]`, far.id)
    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${dims((i) => (i === 0 ? 1 : 0.01)).join(',')}]`, dismissed.id)
    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${dims((i) => (i === 0 ? 1 : 0.01)).join(',')}]`, otherOrgMemory.id)

    stubEmbedding(dims((i) => (i === 0 ? 1 : 0.01)))
    try {
      const hits = await retrieveAgentMemory({ organizationId: ids.org, agentId: ids.agent, query: 'anything', k: 5 })
      assert.ok(hits.length > 0, 'expected hits')
      assert.equal(hits[0].id, near.id)
      const ids_ = hits.map((h: any) => h.id)
      assert.ok(!ids_.includes(dismissed.id), 'dismissed memory must not surface')
      assert.ok(!ids_.includes(otherOrgMemory.id), 'org isolation violated: another org memory surfaced')
    } finally {
      unstubEmbedding()
      await prisma.agentMemory.deleteMany({ where: { id: { in: [near.id, far.id, dismissed.id, otherOrgMemory.id] } } }).catch(() => {})
    }
  })

  test('retrieveAgentMemory: a holder learning surfaces via extraAgentIds, but a holder suggestion does not', async () => {
    if (!vectorReady) return
    const vector = dims((i) => (i === 0 ? 1 : 0.01))
    const holderAgent = await prisma.agentTask.create({
      data: { organizationId: ids.org, type: 'system', agentType: 'SYSTEM', status: 'SYSTEM', priority: 'LOW', visibility: 'private', userId: null, description: 'org intelligence', objective: 'holds org-wide learnings' },
    })
    const learning = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: holderAgent.id, kind: 'learning', title: 'holder learning', content: 'shared fact', status: 'open' },
    })
    const suggestion = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: holderAgent.id, kind: 'suggestion', title: 'holder suggestion', content: 'shared idea', status: 'open' },
    })
    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${vector.join(',')}]`, learning.id)
    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${vector.join(',')}]`, suggestion.id)

    stubEmbedding(vector)
    try {
      const hits = await retrieveAgentMemory({ organizationId: ids.org, agentId: ids.agent, query: 'anything', k: 5, extraAgentIds: [holderAgent.id] })
      const hitIds = hits.map((h: any) => h.id)
      assert.ok(hitIds.includes(learning.id), 'holder learning must surface for a different agent')
      assert.ok(!hitIds.includes(suggestion.id), 'holder suggestion must never surface for a different agent')

      // Without extraAgentIds, neither holder row surfaces at all.
      const withoutExtra = await retrieveAgentMemory({ organizationId: ids.org, agentId: ids.agent, query: 'anything', k: 5 })
      const withoutExtraIds = withoutExtra.map((h: any) => h.id)
      assert.ok(!withoutExtraIds.includes(learning.id))
      assert.ok(!withoutExtraIds.includes(suggestion.id))
    } finally {
      unstubEmbedding()
      await prisma.agentMemory.deleteMany({ where: { id: { in: [learning.id, suggestion.id] } } }).catch(() => {})
      await prisma.agentTask.delete({ where: { id: holderAgent.id } }).catch(() => {})
    }
  })

  test('retrieveAgentMemory falls back to keyword scoring when embeddings are unconfigured', async () => {
    if (!vectorReady) return
    const row = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'keyword title', content: 'a very specific unique phrase', status: 'open' },
    })
    try {
      delete process.env.VOYAGE_API_KEY
      const hits = await retrieveAgentMemory({ organizationId: ids.org, agentId: ids.agent, query: 'a very specific unique phrase', k: 5 })
      assert.ok(hits.some((h: any) => h.id === row.id))
    } finally {
      await prisma.agentMemory.delete({ where: { id: row.id } }).catch(() => {})
    }
  })

  test('saveAgentMemory dedupes a near-identical suggestion embedding against the existing open row', async () => {
    if (!vectorReady) return
    const vector = dims((i) => (i === 0 ? 1 : 0.01))
    stubEmbedding(vector)
    let firstId: string | undefined
    try {
      const first = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'suggestion',
        title: 'Suggestion A',
        content: 'Consider doing X',
      })
      assert.ok(first)
      assert.equal(first!.deduped, false)
      firstId = first!.id

      const second = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'suggestion',
        title: 'Suggestion A (again)',
        content: 'Consider doing X',
      })
      assert.ok(second)
      assert.equal(second!.deduped, true)
      assert.equal(second!.id, firstId)

      const row = await prisma.agentMemory.findUnique({ where: { id: firstId, organizationId: ids.org } })
      assert.equal(row.timesUsed, 1)
    } finally {
      unstubEmbedding()
      if (firstId) await prisma.agentMemory.delete({ where: { id: firstId } }).catch(() => {})
    }
  })

  test('saveAgentMemory persists sourceRef when provided, and leaves it null otherwise', async () => {
    if (!vectorReady) return
    stubEmbedding(dims(() => 0.03))
    let withRefId: string | undefined
    let withoutRefId: string | undefined
    try {
      const withRef = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'learning',
        title: 'How we use Slack: channel triage',
        content: 'The team triages support requests in #support',
        sourceRef: 'mcp:conn123',
      })
      assert.ok(withRef)
      withRefId = withRef!.id
      const withRefRow = await prisma.agentMemory.findUnique({ where: { id: withRefId, organizationId: ids.org } })
      assert.equal(withRefRow.sourceRef, 'mcp:conn123')

      const withoutRef = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'learning',
        title: 'No source ref here',
        content: 'A learning with no connection source',
      })
      assert.ok(withoutRef)
      withoutRefId = withoutRef!.id
      const withoutRefRow = await prisma.agentMemory.findUnique({ where: { id: withoutRefId, organizationId: ids.org } })
      assert.equal(withoutRefRow.sourceRef, null)
    } finally {
      unstubEmbedding()
      if (withRefId) await prisma.agentMemory.delete({ where: { id: withRefId } }).catch(() => {})
      if (withoutRefId) await prisma.agentMemory.delete({ where: { id: withoutRefId } }).catch(() => {})
    }
  })

  test('saveAgentMemory keeps a dismissed learning dismissed on rescan (same sourceRef, near-dup)', async () => {
    if (!vectorReady) return
    const vector = dims((i) => (i === 0 ? 1 : 0.01))
    stubEmbedding(vector)
    let firstId: string | undefined
    try {
      const first = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'learning',
        title: 'How we use Slack: channel triage',
        content: 'The team triages support requests in #support',
        sourceRef: 'mcp:connABC',
      })
      assert.ok(first)
      firstId = first!.id

      // Simulate the DELETE /api/intelligence/learnings soft-delete.
      await prisma.agentMemory.update({ where: { id: firstId, organizationId: ids.org }, data: { status: 'dismissed' } })

      // Rescan re-derives a near-identical learning for the same connection.
      const second = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'learning',
        title: 'How we use Slack: channel triage (again)',
        content: 'The team triages support requests in #support',
        sourceRef: 'mcp:connABC',
      })
      assert.ok(second)
      assert.equal(second!.deduped, true)
      assert.equal(second!.id, firstId, 'must dedupe onto the existing row, not insert a fresh one')

      const row = await prisma.agentMemory.findUnique({ where: { id: firstId, organizationId: ids.org } })
      assert.equal(row.status, 'dismissed', 'a dismissed learning must stay dismissed across rescan')

      const allForAgent = await prisma.agentMemory.findMany({ where: { organizationId: ids.org, agentId: ids.agent, sourceRef: 'mcp:connABC' } })
      assert.equal(allForAgent.length, 1, 'no new open row should have been inserted')
    } finally {
      unstubEmbedding()
      if (firstId) await prisma.agentMemory.delete({ where: { id: firstId } }).catch(() => {})
    }
  })

  test('saveAgentMemory does not dedupe near-identical learnings across different sourceRefs', async () => {
    if (!vectorReady) return
    const vector = dims((i) => (i === 0 ? 1 : 0.01))
    stubEmbedding(vector)
    let firstId: string | undefined
    let secondId: string | undefined
    try {
      const first = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'learning',
        title: 'How we use Notion: doc triage',
        content: 'The team triages docs in the shared workspace',
        sourceRef: 'mcp:connOne',
      })
      assert.ok(first)
      firstId = first!.id

      const second = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'learning',
        title: 'How we use Notion: doc triage',
        content: 'The team triages docs in the shared workspace',
        sourceRef: 'mcp:connTwo',
      })
      assert.ok(second)
      secondId = second!.id
      assert.equal(second!.deduped, false, 'a different connection must not dedupe against another connection\'s learning')
      assert.notEqual(second!.id, firstId)
    } finally {
      unstubEmbedding()
      if (firstId) await prisma.agentMemory.delete({ where: { id: firstId } }).catch(() => {})
      if (secondId) await prisma.agentMemory.delete({ where: { id: secondId } }).catch(() => {})
    }
  })

  test('saveAgentMemory also writes the pgvector column alongside the legacy Json column', async () => {
    if (!vectorReady) return
    stubEmbedding(dims(() => 0.02))
    let id: string | undefined
    try {
      const saved = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'learning',
        title: 'Vector write check',
        content: 'some learned fact',
      })
      assert.ok(saved)
      id = saved!.id
      const rows = await prisma.$queryRaw<Array<{ has_vec: boolean }>>`
        SELECT "embeddingVec" IS NOT NULL AS has_vec FROM "agent_memories" WHERE "id" = ${id}
      `
      assert.equal(rows[0]?.has_vec, true)
    } finally {
      unstubEmbedding()
      if (id) await prisma.agentMemory.delete({ where: { id } }).catch(() => {})
    }
  })
}
