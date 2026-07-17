import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryGraphStore } from '@/lib/rag/memory-store'
import { userEventGraphParts, type PersistedUserEvent } from '@/lib/behavior/index-user-event'
import { mineUserPatternCandidates } from '@/lib/behavior/mine-patterns'
import { isPatternEligible } from '@/lib/behavior/eligibility'
import { userInferenceGraphParts } from '@/lib/behavior/user-insights'
import { parseUserSuggestions } from '@/lib/intelligence/suggest-user-workflows'

const now = new Date('2026-07-17T12:00:00Z')
const day = 24 * 60 * 60 * 1000
let n = 0
const run = (agent: string, at: Date): PersistedUserEvent => ({
  id: `e${++n}`, organizationId: 'org-1', userId: 'u-1', kind: 'agent_run_manual',
  resourceType: 'agent', resourceId: agent, context: { name: 'Pipeline review' }, occurredAt: at,
})

// A Monday routine: same agent, same weekday, three weeks running.
const events = [
  run('a-1', new Date('2026-06-22T09:00:00Z')),
  run('a-1', new Date('2026-06-29T09:05:00Z')),
  run('a-1', new Date('2026-07-06T09:10:00Z')),
]

test('full pipeline: project → mine → gate → evidence-cited pattern node → validated suggestion', async () => {
  const store = new MemoryGraphStore()
  const fakeEmbedding = () => [1, 0, 0]

  // 1. project the ledger (as commitGraph would, with a fake embedding)
  for (const event of events) {
    const { nodes, edges } = userEventGraphParts(event)
    await store.upsertNodes(nodes.map((node) => ({
      ...node, organizationId: 'org-1', embedding: fakeEmbedding(),
      ownerUserId: node.ownerUserId ?? null, visibility: node.visibility ?? 'shared',
      updatedAt: now.toISOString(),
    })))
    await store.upsertEdges(edges)
  }

  // 2. mine real patterns
  const candidates = mineUserPatternCandidates(events)
  const routine = candidates.find((c) => c.kind === 'temporal')
  assert.ok(routine, 'expected a temporal routine')
  assert.equal(routine.occurrenceCount, 3)

  // 3. gate passes (3x over 14 days, user learning-period long over)
  const firstEventAt = new Date(now.getTime() - 30 * day)
  assert.equal(isPatternEligible({ ...routine, status: 'open' }, firstEventAt, now), true)

  // 4. pattern node cites its evidence in the graph
  const { nodes, edges } = userInferenceGraphParts({
    organizationId: 'org-1', userId: 'u-1', slug: routine.slug,
    text: routine.summary, evidenceEventIds: routine.evidenceEventIds,
  })
  await store.upsertNodes(nodes.map((node) => ({
    ...node, organizationId: 'org-1', embedding: fakeEmbedding(),
    ownerUserId: node.ownerUserId ?? null, visibility: node.visibility ?? 'shared',
    updatedAt: now.toISOString(),
  })))
  await store.upsertEdges(edges)
  const neighborhood = await store.expand('org-1', 'u-1', [nodes[0].id], 1)
  assert.ok(neighborhood.some((node) => node.id === `uevent:${events[0].id}`), 'evidence edge must reach the ledger event node')

  // 5. private visibility: another user cannot see the pattern
  const foreign = await store.expand('org-1', 'u-2', [nodes[0].id], 1)
  assert.equal(foreign.length, 0)

  // 6. a suggestion citing the mined slug validates; an uncited one dies
  const validSlugs = new Set([routine.slug])
  assert.ok(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 'Schedule the Monday review', description: 'd', flowPrompt: 'p', sourcePatternSlugs: [routine.slug] },
  }), validSlugs))
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 'Vibes', description: 'd', flowPrompt: 'p', sourcePatternSlugs: ['invented'] },
  }), validSlugs), null)
})

test('negative case: a burst pattern or learning-period user produces NOTHING', () => {
  const burst = [
    run('a-9', new Date('2026-07-16T09:00:00Z')),
    run('a-9', new Date('2026-07-16T10:30:00Z')),
    run('a-9', new Date('2026-07-16T12:00:00Z')),
  ]
  const candidates = mineUserPatternCandidates(burst)
  for (const candidate of candidates) {
    // same-day repetition: span < 7 days → the gate rejects every candidate
    assert.equal(isPatternEligible({ ...candidate, status: 'open' }, new Date(now.getTime() - 30 * day), now), false)
  }
  // and even a strong pattern is silenced during the learning period
  const routine = mineUserPatternCandidates(events).find((c) => c.kind === 'temporal')
  assert.ok(routine)
  assert.equal(isPatternEligible({ ...routine, status: 'open' }, new Date(now.getTime() - 3 * day), now), false)
})
