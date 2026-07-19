import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionize,
  mineToolCorrelations,
  mineCapabilityGaps,
  MIN_CORRELATION_SESSIONS,
  type GapInputs,
} from '@/lib/behavior/mine-correlations'
import type { LedgerEvent } from '@/lib/behavior/mine-patterns'

const at = (iso: string) => new Date(iso)
let n = 0
const ev = (
  kind: string,
  resourceType: string | null,
  resourceId: string | null,
  occurredAt: Date,
  context: Record<string, unknown> = {},
): LedgerEvent => ({ id: `e${++n}`, userId: 'u-1', kind, resourceType, resourceId, context, occurredAt })

const toolCall = (provider: string, occurredAt: Date, toolNames: string[] = ['do_thing']) =>
  ev('tool_call', 'integration', provider, occurredAt, { provider, toolNames, executionId: 'x' })

/** A qualifying session: one interactive anchor + tool calls on two providers. */
const pairSession = (dayIso: string) => [
  ev('agent_run_manual', 'agent', 'a-1', at(`${dayIso}T09:00:00Z`)),
  toolCall('asana', at(`${dayIso}T09:05:00Z`), ['list_tasks']),
  toolCall('github', at(`${dayIso}T09:10:00Z`), ['list_prs']),
]

test('sessionize: splits on 30min inactivity gaps', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-01T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-01T09:20:00Z')),
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-01T11:00:00Z')), // >30min later
  ]
  const sessions = sessionize(events)
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].length, 2)
  assert.equal(sessions[1].length, 1)
})

test('tool_correlation: >=5 interactive sessions across >=3 days yields a candidate', () => {
  const events = [
    ...pairSession('2026-06-01'),
    ...pairSession('2026-06-02'),
    ...pairSession('2026-06-03'),
    ...pairSession('2026-06-04'),
    ...pairSession('2026-06-05'),
  ]
  const candidates = mineToolCorrelations(events)
  assert.equal(candidates.length, 1)
  const c = candidates[0]
  assert.equal(c.kind, 'tool_correlation')
  assert.equal(c.slug, 'toolcorr:asana+github')
  assert.equal(c.occurrenceCount, MIN_CORRELATION_SESSIONS)
  assert.equal(c.evidenceEventIds.length, 10) // the tool_call events of qualifying sessions
  assert.ok(c.summary.includes('asana'))
  assert.ok(c.summary.includes('github'))
})

test('tool_correlation: below the session threshold yields nothing', () => {
  const events = [
    ...pairSession('2026-06-01'),
    ...pairSession('2026-06-02'),
    ...pairSession('2026-06-03'),
    ...pairSession('2026-06-04'),
  ]
  assert.equal(mineToolCorrelations(events).length, 0)
})

test('tool_correlation: sessions without an interactive anchor do not count (scheduled runs)', () => {
  // Five days of tool_call pairs with NO interactive event in the session —
  // e.g. a scheduled flow touching both providers. Must not mine a correlation.
  const events = ['01', '02', '03', '04', '05'].flatMap((d) => [
    toolCall('asana', at(`2026-06-${d}T03:00:00Z`)),
    toolCall('github', at(`2026-06-${d}T03:01:00Z`)),
  ])
  assert.equal(mineToolCorrelations(events).length, 0)
})

test('tool_correlation: fewer than 3 distinct days yields nothing', () => {
  const events = [
    ...pairSession('2026-06-01'),
    // 4 more sessions on only one more day, separated by >30min gaps
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-02T08:00:00Z')),
    toolCall('asana', at('2026-06-02T08:01:00Z')),
    toolCall('github', at('2026-06-02T08:02:00Z')),
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-02T10:00:00Z')),
    toolCall('asana', at('2026-06-02T10:01:00Z')),
    toolCall('github', at('2026-06-02T10:02:00Z')),
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-02T12:00:00Z')),
    toolCall('asana', at('2026-06-02T12:01:00Z')),
    toolCall('github', at('2026-06-02T12:02:00Z')),
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-02T14:00:00Z')),
    toolCall('asana', at('2026-06-02T14:01:00Z')),
    toolCall('github', at('2026-06-02T14:02:00Z')),
  ]
  assert.equal(mineToolCorrelations(events).length, 0)
})

const gapInputs = (overrides: Partial<GapInputs> = {}): GapInputs => ({
  capabilitiesByProvider: new Map(),
  manualTriggerFlowIds: new Set(),
  now: at('2026-07-18T12:00:00Z'),
  ...overrides,
})

test('capability_gap dormant: connection added >=30d ago with zero tool_call events', () => {
  const added = ev('connection_added', 'connection', 'c-1', at('2026-06-01T09:00:00Z'), { provider: 'slack' })
  const gaps = mineCapabilityGaps([added], gapInputs())
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].kind, 'capability_gap')
  assert.equal(gaps[0].slug, 'gap:dormant:slack')
  assert.deepEqual(gaps[0].evidenceEventIds, [added.id])
  assert.equal(gaps[0].lastSeenAt.toISOString(), '2026-07-18T12:00:00.000Z') // gap observed now
})

test('capability_gap dormant: a used or recently added connection is not dormant', () => {
  const recent = ev('connection_added', 'connection', 'c-2', at('2026-07-10T09:00:00Z'), { provider: 'gmail' })
  const old = ev('connection_added', 'connection', 'c-3', at('2026-05-01T09:00:00Z'), { provider: 'asana' })
  const used = toolCall('asana', at('2026-07-01T09:00:00Z'))
  assert.equal(mineCapabilityGaps([old, recent, used], gapInputs()).length, 0)
})

test('capability_gap schedule: temporal routine on a manual-trigger flow', () => {
  const runs = [
    ev('flow_run_manual', 'flow', 'f-9', at('2026-07-06T09:00:00Z')), // Monday
    ev('flow_run_manual', 'flow', 'f-9', at('2026-07-13T09:00:00Z')), // Monday
    ev('flow_run_manual', 'flow', 'f-9', at('2026-06-29T09:00:00Z')), // Monday
  ]
  const gaps = mineCapabilityGaps(runs, gapInputs({ manualTriggerFlowIds: new Set(['f-9']) }))
  const schedule = gaps.find((g) => g.slug === 'gap:schedule:f-9')
  assert.ok(schedule)
  assert.equal(schedule.occurrenceCount, 3)
  assert.equal(schedule.evidenceEventIds.length, 3)
})

test('capability_gap schedule: a flow not manual-triggered produces no gap', () => {
  const runs = [
    ev('flow_run_manual', 'flow', 'f-8', at('2026-07-06T09:00:00Z')),
    ev('flow_run_manual', 'flow', 'f-8', at('2026-07-13T09:00:00Z')),
    ev('flow_run_manual', 'flow', 'f-8', at('2026-06-29T09:00:00Z')),
  ]
  assert.equal(mineCapabilityGaps(runs, gapInputs()).length, 0)
})

test('capability_gap unused capability: correlated provider with uncalled catalog tools', () => {
  const events = [
    ...pairSession('2026-07-01'),
    ...pairSession('2026-07-02'),
    ...pairSession('2026-07-03'),
    ...pairSession('2026-07-06'),
    ...pairSession('2026-07-07'),
  ]
  const inputs = gapInputs({
    capabilitiesByProvider: new Map([['asana', ['list_tasks', 'create_task']]]),
  })
  const gaps = mineCapabilityGaps(events, inputs)
  const unused = gaps.filter((g) => g.slug.startsWith('gap:capability:'))
  assert.equal(unused.length, 1) // list_tasks was called; create_task was not
  assert.equal(unused[0].slug, 'gap:capability:asana:create_task')
  assert.ok(unused[0].evidenceEventIds.length > 0)
})

test('capability_gap: no false positives when everything is active and scheduled', () => {
  const events = [
    ev('connection_added', 'connection', 'c-4', at('2026-06-01T09:00:00Z'), { provider: 'asana' }),
    ...pairSession('2026-07-01'),
    ...pairSession('2026-07-02'),
    ...pairSession('2026-07-03'),
    ...pairSession('2026-07-06'),
    ...pairSession('2026-07-07'),
  ]
  const inputs = gapInputs({
    capabilitiesByProvider: new Map([['asana', ['list_tasks']]]), // fully used
  })
  assert.equal(mineCapabilityGaps(events, inputs).length, 0)
})
