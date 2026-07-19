import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  minePeerPractices,
  groupProvidersByExecution,
  MIN_PEER_RUNS,
  type PeerPracticeInputs,
} from '@/lib/behavior/mine-peer-practices'
import type { LedgerEvent } from '@/lib/behavior/mine-patterns'

const at = (iso: string) => new Date(iso)
let n = 0
const toolCall = (provider: string, occurredAt: Date): LedgerEvent => ({
  id: `e${++n}`,
  userId: 'u-1',
  kind: 'tool_call',
  resourceType: 'integration',
  resourceId: provider,
  context: { provider, toolNames: ['do_thing'], executionId: 'x' },
  occurredAt,
})

const now = at('2026-07-18T12:00:00Z')
const inputs = (overrides: Partial<PeerPracticeInputs> = {}): PeerPracticeInputs => ({
  peerFlows: [{
    id: 'f-peer',
    name: 'Standup digest',
    providers: ['asana', 'slack'],
    successfulRuns: 8,
    firstRunAt: at('2026-06-20T09:00:00Z'),
  }],
  ownFlowProviders: [],
  now,
  ...overrides,
})

const touchesAsana = [toolCall('asana', at('2026-07-10T09:00:00Z')), toolCall('asana', at('2026-07-15T09:00:00Z'))]

test('qualifying peer flow with provider overlap mines a candidate', () => {
  const candidates = minePeerPractices(touchesAsana, inputs())
  assert.equal(candidates.length, 1)
  const c = candidates[0]
  assert.equal(c.kind, 'peer_practice')
  assert.equal(c.slug, 'peer:flow:f-peer')
  assert.equal(c.occurrenceCount, 8)
  assert.equal(c.firstSeenAt.toISOString(), '2026-06-20T09:00:00.000Z')
  assert.equal(c.lastSeenAt.toISOString(), now.toISOString())
  // Evidence is the USER'S OWN tool_call events on the overlapping providers.
  assert.deepEqual(c.evidenceEventIds, touchesAsana.map((e) => e.id))
  assert.ok(c.summary.includes('Standup digest'))
})

test('privacy: summary and evidence never reference a teammate identity', () => {
  const c = minePeerPractices(touchesAsana, inputs())[0]
  assert.ok(!JSON.stringify(c).includes('u-2'))
})

test(`fewer than ${MIN_PEER_RUNS} successful runs mines nothing`, () => {
  const weak = inputs()
  weak.peerFlows[0].successfulRuns = MIN_PEER_RUNS - 1
  assert.equal(minePeerPractices(touchesAsana, weak).length, 0)
})

test('no provider overlap with the user mines nothing', () => {
  const events = [toolCall('github', at('2026-07-10T09:00:00Z'))]
  assert.equal(minePeerPractices(events, inputs()).length, 0)
})

test('a user flow already covering the peer provider set suppresses the candidate', () => {
  const covered = inputs({ ownFlowProviders: [['asana', 'slack', 'gmail']] })
  assert.equal(minePeerPractices(touchesAsana, covered).length, 0)
  // Partial coverage does NOT suppress — the peer flow still adds something.
  const partial = inputs({ ownFlowProviders: [['asana']] })
  assert.equal(minePeerPractices(touchesAsana, partial).length, 1)
})

test('a peer flow with no resolved providers mines nothing (cold start)', () => {
  const cold = inputs()
  cold.peerFlows[0].providers = []
  assert.equal(minePeerPractices(touchesAsana, cold).length, 0)
})

test('groupProvidersByExecution: groups tool_call rows by executionId', () => {
  const rows = [
    { resourceId: 'asana', context: { executionId: 'run-1' } },
    { resourceId: 'slack', context: { executionId: 'run-1' } },
    { resourceId: 'github', context: { executionId: 'run-2' } },
    { resourceId: 'asana', context: null },
    { resourceId: null, context: { executionId: 'run-3' } },
  ]
  const grouped = groupProvidersByExecution(rows)
  assert.deepEqual([...(grouped.get('run-1') ?? [])].sort(), ['asana', 'slack'])
  assert.deepEqual([...(grouped.get('run-2') ?? [])], ['github'])
  assert.equal(grouped.has('run-3'), false)
})
