/**
 * Orchestration tests for `synthesizeWorkflowSuggestions` (review findings
 * 1-3 on Task 3): the below-gate path must not burn a cooldown slot, a
 * downstream failure after a successful claim must release it (best-effort),
 * and a draft flow that fails graph validation must never be persisted while
 * its suggestion memory still is.
 *
 * DB-gated like the rest of this codebase's integration tests (see
 * src/lib/agents/__tests__/approval.test.ts) — self-skips (0 tests reported)
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

  test('a draft flow that fails graph validation is discarded, but its suggestion memory is kept', async () => {
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

    const suggestionMemories = await prisma.agentMemory.findMany({
      where: { organizationId: org.id, agentId, kind: 'suggestion' },
    })
    assert.equal(suggestionMemories.length, 1)
    assert.equal(suggestionMemories[0].title, 'Daily standup digest')
  })
}
