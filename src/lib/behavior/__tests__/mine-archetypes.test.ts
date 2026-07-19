import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mineArchetypeGaps, MAX_ARCHETYPE_CANDIDATES, type ArchetypeInputs } from '@/lib/behavior/mine-archetypes'
import type { LedgerEvent } from '@/lib/behavior/mine-patterns'

const at = (iso: string) => new Date(iso)
let n = 0
const toolCall = (provider: string): LedgerEvent => ({
  id: `e${++n}`,
  userId: 'u-1',
  kind: 'tool_call',
  resourceType: 'integration',
  resourceId: provider,
  context: { provider, toolNames: ['t'], executionId: 'x' },
  occurredAt: at('2026-07-15T09:00:00Z'),
})

const now = at('2026-07-18T12:00:00Z')
const archetype = (signature: string, providers: string[], triggerType: string, orgCount: number) => ({
  signature, providers, triggerType, orgCount,
})

const inputs = (overrides: Partial<ArchetypeInputs> = {}): ArchetypeInputs => ({
  archetypes: [archetype('asana+slack:schedule', ['asana', 'slack'], 'schedule', 12)],
  orgShapeSignatures: new Set<string>(),
  orgProviders: new Set(['asana', 'slack', 'github']),
  now,
  ...overrides,
})

test('qualifying archetype gap mines a candidate with own-event evidence', () => {
  const events = [toolCall('asana'), toolCall('asana')]
  const candidates = mineArchetypeGaps(events, inputs())
  assert.equal(candidates.length, 1)
  const c = candidates[0]
  assert.equal(c.kind, 'archetype_gap')
  assert.equal(c.slug, 'archetype:asana+slack:schedule')
  assert.equal(c.occurrenceCount, 12)
  assert.equal(c.lastSeenAt.toISOString(), now.toISOString())
  assert.deepEqual(c.evidenceEventIds, events.map((e) => e.id))
  assert.ok(c.summary.includes('12 other organizations'))
})

test('org already has the shape → suppressed', () => {
  const suppressed = inputs({ orgShapeSignatures: new Set(['asana+slack:schedule']) })
  assert.equal(mineArchetypeGaps([toolCall('asana')], suppressed).length, 0)
})

test('org missing one of the archetype providers → no candidate', () => {
  const partial = inputs({ orgProviders: new Set(['asana']) })
  assert.equal(mineArchetypeGaps([toolCall('asana')], partial).length, 0)
})

test('user never touched any archetype provider → no candidate (no evidence)', () => {
  assert.equal(mineArchetypeGaps([toolCall('github')], inputs()).length, 0)
})

test('ranked by orgCount desc and capped', () => {
  const many = inputs({
    archetypes: [
      archetype('a+b:manual', ['a', 'b'], 'manual', 6),
      archetype('a+c:manual', ['a', 'c'], 'manual', 20),
      archetype('a+d:manual', ['a', 'd'], 'manual', 9),
      archetype('a+e:manual', ['a', 'e'], 'manual', 15),
    ],
    orgProviders: new Set(['a', 'b', 'c', 'd', 'e']),
  })
  const candidates = mineArchetypeGaps([toolCall('a')], many)
  assert.equal(candidates.length, MAX_ARCHETYPE_CANDIDATES)
  assert.deepEqual(candidates.map((c) => c.occurrenceCount), [20, 15, 9])
})
