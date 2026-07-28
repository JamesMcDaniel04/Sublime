import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLinkedGoalIds } from '@/lib/integrations/goals-port'
import { goalWorkSection } from '../strategy'
import { goalsTools } from '@/lib/integrations/goals'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'

type Row = { goalId: string }

function fakeDb(rows: Row[]) {
  const calls: unknown[] = []
  return {
    calls,
    goalContribution: {
      async findMany(args: unknown) {
        calls.push(args)
        return rows
      },
    },
  }
}

test('linked goal ids are scoped by organization AND resource identity', async () => {
  const db = fakeDb([{ goalId: 'goal-a' }, { goalId: 'goal-b' }])
  const ids = await resolveLinkedGoalIds('org-1', { type: 'agent', id: 'agent-9' }, db)

  assert.deepEqual(ids, ['goal-a', 'goal-b'])
  assert.deepEqual((db.calls[0] as { where: unknown }).where, {
    organizationId: 'org-1',
    resourceType: 'agent',
    resourceId: 'agent-9',
  })
})

test('a resource with no contribution resolves to an empty set', async () => {
  const ids = await resolveLinkedGoalIds('org-1', { type: 'flow', id: 'flow-3' }, fakeDb([]))
  assert.deepEqual(ids, [])
})

test('duplicate contribution rows collapse to a unique id set', async () => {
  const ids = await resolveLinkedGoalIds(
    'org-1',
    { type: 'agent', id: 'agent-9' },
    fakeDb([{ goalId: 'goal-a' }, { goalId: 'goal-a' }]),
  )
  assert.deepEqual(ids, ['goal-a'])
})

// ── Goal work section ──────────────────────────────────────────────────────
// The workroom is only ever as full as the agents' willingness to log. An
// agent holding log_work but never told to call it leaves every funnel at
// zero, so the instruction is injected from tool presence at run time rather
// than baked into stored instructions that can drift.

test('goalWorkSection appears only when the agent actually holds log_work', () => {
  assert.equal(goalWorkSection([]), '')
  assert.equal(goalWorkSection([{ name: 'slack_post' }]), '')
  assert.ok(goalWorkSection([{ name: 'log_work' }]).startsWith('## Recording your work'))
})

test('goalWorkSection demands one call per subject, not one per run', () => {
  // A single row summarizing a batch destroys the per-subject outcome signal
  // the whole ledger exists to capture.
  const section = goalWorkSection([{ name: 'log_work' }])
  assert.match(section, /once per subject/i)
  assert.match(section, /never .*summar/i)
})

test('goalWorkSection tells the agent to read list_work first when it has it', () => {
  const withList = goalWorkSection([{ name: 'log_work' }, { name: 'list_work' }])
  assert.match(withList, /list_work/)
  assert.match(withList, /skipped/i, 'it must say to learn from what people skipped')

  // Without list_work there is nothing to read, so the guidance must not
  // instruct a call the agent cannot make.
  const withoutList = goalWorkSection([{ name: 'log_work' }])
  assert.doesNotMatch(withoutList, /list_work/)
})

test('goalWorkSection asks for an assignee hint and a usable artifact', () => {
  const section = goalWorkSection([{ name: 'log_work' }])
  assert.match(section, /assigneeHint/)
  assert.match(section, /subjectRef/)
})

test('the tools the goals plane exposes are exactly the ones that trigger the instruction', () => {
  // The two halves are wired independently — the plane decides what tools
  // exist, strategy decides what the agent is told. If they drift, agents
  // hold log_work and are never told to call it, and every funnel reads zero.
  const section = goalWorkSection(goalsTools())
  assert.ok(section, 'a goal-linked agent must be told to record its work')
  assert.match(section, /list_work/, 'the plane ships list_work, so the guidance must use it')
})

// ── Flows reach the goals plane ────────────────────────────────────────────
// GoalContribution and GoalWork both model resourceType 'flow'. Until the
// executor could construct a goals client for a flow, that was a promise the
// schema made and the runtime could not keep.

test('the goals connector is a builtin the flow executor must be able to resolve', () => {
  const goalsConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'sublime-goals')
  assert.ok(goalsConn, 'sublime-goals must be a registered builtin connector')
  assert.equal(goalsConn.kind, 'builtin')
})

test('a flow resource resolves its own linked goals, scoped to the flow', async () => {
  // Same authorization input agents use — the returned set is the client's
  // entire reachable universe, so a flow can only ever touch goals it is
  // actually linked to.
  const db = fakeDb([{ goalId: 'goal-1' }, { goalId: 'goal-1' }, { goalId: 'goal-2' }])
  const ids = await resolveLinkedGoalIds('org-1', { type: 'flow', id: 'flow-9' }, db as never)
  assert.deepEqual(ids, ['goal-1', 'goal-2'], 'deduped')
  assert.deepEqual(db.calls[0], {
    where: { organizationId: 'org-1', resourceType: 'flow', resourceId: 'flow-9' },
    select: { goalId: true },
  })
})
