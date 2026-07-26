/**
 * Orchestration tests for `synthesizeWorkflowSuggestions` (review findings
 * 1-3 on Task 3): the below-gate path must not burn a cooldown slot, a
 * downstream failure after a successful claim must release it (best-effort),
 * and a draft flow that fails graph validation must never be persisted while
 * its suggestion memory still is.
 *
 * DB-gated like the rest of this codebase's integration tests (see
 * other DB-backed suites) — self-skips (0 tests reported)
 * when TEST_DATABASE_URL isn't set. `generate`/`generateGraph` are injected
 * via `synthesizeWorkflowSuggestions`'s overrides seam so no LLM call is ever
 * made; everything else (gate, cooldown claim/release, memory/flow
 * persistence) runs against a real Postgres so the atomic-claim SQL and the
 * validation-gated flow.create are genuinely exercised, not just their pure
 * seams.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let synthesizeWorkflowSuggestions: any
  const orgIds: string[] = []

  async function makeOrgWithConnections(connectionCount: number) {
    const org = await prisma.organization.create({ data: { name: 'Synth', slug: `synth-${crypto.randomUUID()}` } })
    orgIds.push(org.id)
    for (let i = 0; i < connectionCount; i += 1) {
      await prisma.mcpConnection.create({
        data: { organizationId: org.id, name: `conn-${i}`, serverUrl: 'https://example.com/mcp', isActive: true },
      })
    }
    if (connectionCount >= 3) {
      await prisma.userEvent.createMany({
        data: Array.from({ length: 10 }, (_, index) => ({
          organizationId: org.id,
          userId: 'synthesis-test-user',
          kind: 'tool_call',
          resourceType: 'tool',
          resourceId: `tool-${index}`,
          context: {},
        })),
      })
    }
    return org
  }

  async function addLearningMemory(organizationId: string) {
    const { orgIntelligenceAgentId } = await import('../connection-scan')
    const agentId = await orgIntelligenceAgentId(organizationId)
    await prisma.agentMemory.create({
      data: {
        organizationId,
        agentId,
        kind: 'learning',
        title: 'How we use Slack: daily standup summary',
        content: 'The team posts a daily standup summary to #general every morning.',
      },
    })
    return agentId
  }

  // Embedding stub (mirrors agent-memory-vector.test.ts): forces saveAgentMemory's
  // pgvector dedupe path to actually run for kind:'suggestion' writes, so the
  // retry/dedupe tests below can prove a fix-C regression would have deduped
  // (and therefore skipped generation) instead of merely asserting on
  // pass-through behavior that never engages dedupe at all.
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
  const fixedVector = Array.from({ length: 1024 }, () => 0.03)

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ synthesizeWorkflowSuggestions } = await import('../suggest-workflows'))
  })

  after(async () => {
    for (const id of orgIds) {
      await prisma.flow.deleteMany({ where: { organizationId: id } })
      await prisma.agentMemory.deleteMany({ where: { organizationId: id } })
      await prisma.agentTask.deleteMany({ where: { organizationId: id } })
      await prisma.mcpConnection.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } })
    }
  })

  test('below-gate: skips before writing any cooldown claim', async () => {
    const org = await makeOrgWithConnections(2) // below the >=3 gate

    const result = await synthesizeWorkflowSuggestions(org.id)
    assert.deepEqual(result, { skipped: 'below-gate' })

    const refreshed = await prisma.organization.findUnique({ where: { id: org.id }, select: { settings: true } })
    assert.equal((refreshed.settings as any)?.lastSuggestionSynthesisAt, undefined)
  })

  test('claim is released (best-effort) when generation fails after a successful claim', async () => {
    const org = await makeOrgWithConnections(3)
    await addLearningMemory(org.id)

    const result = await synthesizeWorkflowSuggestions(org.id, {
      generate: async () => {
        throw new Error('LLM unavailable')
      },
    })
    assert.deepEqual(result, { skipped: 'error' })

    // The claim was written (atomically) and then released back to its
    // pre-claim state (absent, since this org never synthesized before) —
    // not left dangling for a full day.
    const refreshed = await prisma.organization.findUnique({ where: { id: org.id }, select: { settings: true } })
    assert.equal((refreshed.settings as any)?.lastSuggestionSynthesisAt, undefined)

    // A second call in the same "day" is not throttled by a stale claim.
    const secondAttempt = await synthesizeWorkflowSuggestions(org.id, {
      generate: async () => JSON.stringify({ suggestions: [], improvements: [] }),
    })
    assert.deepEqual(secondAttempt, { synthesized: true, newFlows: 0, improvements: 0, discarded: 0 })
  })

  test('a draft flow that fails graph validation is discarded, and its suggestion memory is deleted so a later pass can retry', async () => {
    const org = await makeOrgWithConnections(3)
    const agentId = await addLearningMemory(org.id)
    await prisma.user.create({ data: { organizationId: org.id, supabaseId: crypto.randomUUID(), isActive: true } })

    const result = await synthesizeWorkflowSuggestions(org.id, {
      generate: async () =>
        JSON.stringify({
          suggestions: [{ title: 'Daily standup digest', description: 'Summarize standups to Slack.', flowPrompt: 'Every morning, post a standup summary to Slack.' }],
          improvements: [],
        }),
      generateGraph: async () => ({
        graph: { nodes: [], edges: [] } as any,
        validation: { ok: false, errors: [{ message: 'trigger node missing' }], warnings: [] } as any,
        needsAttention: [{ message: 'trigger node missing' }],
      }),
    })

    assert.equal((result as any).synthesized, true)
    assert.equal((result as any).newFlows, 0)
    assert.equal((result as any).discarded, 1)

    const flows = await prisma.flow.findMany({ where: { organizationId: org.id } })
    assert.equal(flows.length, 0)

    // Task 5 fix C: a transient/unusable-draft failure must not permanently
    // block this suggestion behind a dedupe wall — the just-saved memory is
    // deleted (not left `open`), so an identical idea proposed on a later
    // pass inserts fresh instead of deduping onto a dead end.
    const suggestionMemories = await prisma.agentMemory.findMany({
      where: { organizationId: org.id, agentId, kind: 'suggestion' },
    })
    assert.equal(suggestionMemories.length, 0, 'the failed draft\'s suggestion memory must not linger and block a retry')
  })

  test('fix C: a generation failure does not block retry — pass 2 (next day) creates the flow once validation passes', async () => {
    const org = await makeOrgWithConnections(3)
    const agentId = await addLearningMemory(org.id)
    await prisma.user.create({ data: { organizationId: org.id, supabaseId: crypto.randomUUID(), isActive: true } })

    stubEmbedding(fixedVector)
    try {
      const suggestion = { title: 'Weekly GitHub digest', description: 'Summarize new issues to Slack.', flowPrompt: 'Every Monday, summarize new GitHub issues into a Slack message.' }
      const generate = async () => JSON.stringify({ suggestions: [suggestion], improvements: [] })

      // Pass 1 (day 1): the idea is good, but the auto-generated draft fails
      // validation.
      const pass1 = await synthesizeWorkflowSuggestions(org.id, {
        generate,
        generateGraph: async () => ({
          graph: { nodes: [], edges: [] } as any,
          validation: { ok: false, errors: [{ message: 'trigger node missing' }], warnings: [] } as any,
          needsAttention: [{ message: 'trigger node missing' }],
        }),
      })
      assert.equal((pass1 as any).discarded, 1)
      assert.equal((pass1 as any).newFlows, 0)

      const afterPass1 = await prisma.agentMemory.findMany({ where: { organizationId: org.id, agentId, kind: 'suggestion' } })
      assert.equal(afterPass1.length, 0, 'the failed suggestion memory must be deleted, not left open to dedupe-block the retry')

      // Pass 2 (simulated next day, past the 24h cooldown): the identical
      // idea (same title/description → same stubbed embedding) is proposed
      // again, and this time the draft validates.
      const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000)
      const pass2 = await synthesizeWorkflowSuggestions(org.id, {
        generate,
        generateGraph: async () => ({
          graph: { nodes: [{ id: 'n1', type: 'trigger', data: {} }], edges: [] } as any,
          validation: { ok: true, errors: [], warnings: [] } as any,
          needsAttention: [],
        }),
        now: () => tomorrow,
      })
      assert.equal((pass2 as any).synthesized, true)
      assert.equal((pass2 as any).newFlows, 1, 'the retry must create the flow — proves pass 1’s memory did not dedupe-block it')

      const flows = await prisma.flow.findMany({ where: { organizationId: org.id } })
      assert.equal(flows.length, 1, 'success path leaves exactly one flow')

      const afterPass2 = await prisma.agentMemory.findMany({ where: { organizationId: org.id, agentId, kind: 'suggestion' } })
      assert.equal(afterPass2.length, 1, 'success path leaves exactly one suggestion memory')
    } finally {
      unstubEmbedding()
    }
  })

  test('fix C: a pre-dismissed suggestion dedupes onto the dismissed row and never regenerates', async () => {
    const org = await makeOrgWithConnections(3)
    const agentId = await addLearningMemory(org.id)
    await prisma.user.create({ data: { organizationId: org.id, supabaseId: crypto.randomUUID(), isActive: true } })

    stubEmbedding(fixedVector)
    try {
      // A previously-dismissed suggestion for the same idea (same stubbed
      // embedding as whatever the model proposes below).
      const dismissed = await prisma.agentMemory.create({
        data: {
          organizationId: org.id,
          agentId,
          kind: 'suggestion',
          title: 'Monthly expense report',
          content: 'Summarize expense submissions to finance.',
          status: 'dismissed',
        },
      })
      await prisma.$executeRawUnsafe(
        `UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
        `[${fixedVector.join(',')}]`,
        dismissed.id,
      )

      let generateGraphCalls = 0
      const result = await synthesizeWorkflowSuggestions(org.id, {
        generate: async () =>
          JSON.stringify({
            suggestions: [{ title: 'Monthly expense report (again)', description: 'Summarize expense submissions to finance.', flowPrompt: 'Every month, summarize expense submissions for finance.' }],
            improvements: [],
          }),
        generateGraph: async () => {
          generateGraphCalls += 1
          return { graph: { nodes: [], edges: [] } as any, validation: { ok: true, errors: [], warnings: [] } as any, needsAttention: [] }
        },
      })

      assert.equal((result as any).synthesized, true)
      assert.equal((result as any).newFlows, 0, 'a dismissed idea must never regenerate a draft flow')
      assert.equal(generateGraphCalls, 0, 'dedupe onto the dismissed row must short-circuit before generation is attempted')

      const flows = await prisma.flow.findMany({ where: { organizationId: org.id } })
      assert.equal(flows.length, 0)

      const suggestionMemories = await prisma.agentMemory.findMany({ where: { organizationId: org.id, agentId, kind: 'suggestion' } })
      assert.equal(suggestionMemories.length, 1, 'no new memory row — dedupes onto the existing dismissed one')
      assert.equal(suggestionMemories[0].id, dismissed.id)
      assert.equal(suggestionMemories[0].status, 'dismissed', 'a dismissed suggestion must stay dismissed')
    } finally {
      unstubEmbedding()
    }
  })
}
