import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mineUserPatternCandidates, mineIntentClusters, type LedgerEvent } from '@/lib/behavior/mine-patterns'

const at = (iso: string) => new Date(iso)
let n = 0
const ev = (kind: string, resourceType: string | null, resourceId: string | null, occurredAt: Date): LedgerEvent => ({
  id: `e${++n}`, userId: 'u-1', kind, resourceType, resourceId, context: {}, occurredAt,
})

test('sequence: adjacent pairs within 60min accumulate real counts + evidence', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-01T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-01T09:10:00Z')),
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-08T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-08T09:05:00Z')),
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-15T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-15T09:20:00Z')),
  ]
  const seq = mineUserPatternCandidates(events).find((c) => c.kind === 'sequence')
  assert.ok(seq)
  assert.equal(seq.occurrenceCount, 3)
  assert.equal(seq.evidenceEventIds.length, 6)
  assert.equal(seq.firstSeenAt.toISOString(), '2026-06-01T09:00:00.000Z')
  assert.equal(seq.lastSeenAt.toISOString(), '2026-06-15T09:20:00.000Z')
})

test('sequence: pairs more than 60min apart do not count', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-01T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-01T11:00:00Z')),
  ]
  assert.equal(mineUserPatternCandidates(events).filter((c) => c.kind === 'sequence').length, 0)
})

test('temporal: same action+resource on the same weekday across distinct dates', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-2', at('2026-06-01T09:00:00Z')), // Monday
    ev('agent_run_manual', 'agent', 'a-2', at('2026-06-08T09:30:00Z')), // Monday
    ev('agent_run_manual', 'agent', 'a-2', at('2026-06-08T09:45:00Z')), // same date — dedupes
    ev('agent_run_manual', 'agent', 'a-2', at('2026-06-15T10:00:00Z')), // Monday
  ]
  const routine = mineUserPatternCandidates(events).find((c) => c.kind === 'temporal')
  assert.ok(routine)
  assert.equal(routine.occurrenceCount, 3)
  assert.ok(routine.slug.endsWith(':1')) // UTC weekday 1 = Monday
})

test('friction: >=3 manual runs of one agent within 60 minutes', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-3', at('2026-06-02T10:00:00Z')),
    ev('agent_run_manual', 'agent', 'a-3', at('2026-06-02T10:10:00Z')),
    ev('agent_run_manual', 'agent', 'a-3', at('2026-06-02T10:20:00Z')),
  ]
  const friction = mineUserPatternCandidates(events).find((c) => c.kind === 'friction')
  assert.ok(friction)
  assert.equal(friction.slug, 'friction:agent:a-3')
})

test('intent: greedy clusters of similar prompts (fake embeddings)', async () => {
  const embed = async (texts: string[]) =>
    texts.map((t) => (t.startsWith('summarize') ? [1, 0] : [0, 1]))
  const prompts = [
    { eventId: 'p1', text: 'summarize my pipeline', occurredAt: at('2026-06-01T09:00:00Z') },
    { eventId: 'p2', text: 'summarize pipeline again', occurredAt: at('2026-06-05T09:00:00Z') },
    { eventId: 'p3', text: 'summarize the pipeline please', occurredAt: at('2026-06-09T09:00:00Z') },
    { eventId: 'p4', text: 'draft an email', occurredAt: at('2026-06-09T10:00:00Z') },
  ]
  const clusters = await mineIntentClusters(prompts, embed)
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].occurrenceCount, 3)
  assert.deepEqual(clusters[0].evidenceEventIds, ['p1', 'p2', 'p3'])
})
