import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nonAdvancingStreak,
  verdictEvidenceLine,
  shouldEscalateStreak,
  recordGoalRunVerdicts,
} from '../verdicts'

const v = (verdict: string, runId: string) => ({ verdict, runId })

test('nonAdvancingStreak counts consecutive non-advancing runs from the most recent', () => {
  assert.equal(nonAdvancingStreak([]), 0)
  assert.equal(nonAdvancingStreak([v('advanced', 'r3'), v('no_change', 'r2')]), 0)
  assert.equal(
    nonAdvancingStreak([v('no_change', 'r4'), v('counterproductive', 'r3'), v('advanced', 'r2'), v('no_change', 'r1')]),
    2,
  )
})

test('nonAdvancingStreak: unclear breaks a streak without starting one', () => {
  assert.equal(nonAdvancingStreak([v('no_change', 'r3'), v('unclear', 'r2'), v('no_change', 'r1')]), 1)
})

test('shouldEscalateStreak fires at every third consecutive non-advancing run', () => {
  assert.equal(shouldEscalateStreak(2), false)
  assert.equal(shouldEscalateStreak(3), true)
  assert.equal(shouldEscalateStreak(4), false)
  assert.equal(shouldEscalateStreak(6), true)
})

test('verdictEvidenceLine aggregates counts and is null without rows', () => {
  assert.equal(verdictEvidenceLine({ total: 0, nonAdvancing: 0 }), null)
  assert.equal(
    verdictEvidenceLine({ total: 9, nonAdvancing: 7 }),
    '9 agent runs completed in the last 30 days; 7 judged non-advancing by reflection.',
  )
  assert.equal(verdictEvidenceLine({ total: 3, nonAdvancing: 0 }), null)
})

test('recordGoalRunVerdicts writes one row per linked goal (bounded to two) and escalates a 3-streak on an at-risk goal', async () => {
  const created: unknown[] = []
  const escalated: Array<{ goalId: string; ownerUserId: string }> = []
  await recordGoalRunVerdicts(
    {
      organizationId: 'org1',
      resourceType: 'agent',
      resourceId: 'agent1',
      runId: 'run9',
      verdict: 'no_change',
      evidence: 'nothing shipped',
    },
    {
      linkedGoalIds: async () => ['g1', 'g2', 'g3'],
      createVerdict: async (row) => {
        created.push(row)
      },
      goalState: async (goalId) =>
        goalId === 'g1'
          ? { name: 'Grow ARR', status: 'active', riskLevel: 'at_risk', ownerUserId: 'u1', createdByUserId: null }
          : { name: 'Other', status: 'active', riskLevel: 'on_track', ownerUserId: 'u1', createdByUserId: null },
      recentVerdicts: async () => [
        { verdict: 'no_change', runId: 'run9' },
        { verdict: 'no_change', runId: 'run8' },
        { verdict: 'counterproductive', runId: 'run7' },
        { verdict: 'advanced', runId: 'run6' },
      ],
      escalate: async (input) => {
        escalated.push({ goalId: input.goalId, ownerUserId: input.ownerUserId })
      },
    },
  )
  assert.equal(created.length, 2) // bounded to two goals
  assert.deepEqual(escalated, [{ goalId: 'g1', ownerUserId: 'u1' }]) // on_track goal never escalates
})

test('recordGoalRunVerdicts persists the exact ranked goals supplied by execution grounding', async () => {
  const created: Array<{ goalId: string }> = []
  let fallbackReads = 0
  await recordGoalRunVerdicts(
    {
      organizationId: 'org1',
      resourceType: 'agent',
      resourceId: 'agent1',
      runId: 'run1',
      verdict: 'advanced',
      evidence: 'moved the metric',
      goalIds: ['highest', 'second', 'third', 'highest'],
    },
    {
      linkedGoalIds: async () => {
        fallbackReads += 1
        return ['arbitrary-first']
      },
      createVerdict: async (row) => {
        created.push({ goalId: row.goalId })
      },
      goalState: async () => null,
      recentVerdicts: async () => [],
      escalate: async () => {},
    },
  )
  assert.equal(fallbackReads, 0)
  assert.deepEqual(created, [{ goalId: 'highest' }, { goalId: 'second' }])
})

test('recordGoalRunVerdicts never escalates below the streak threshold', async () => {
  const escalated: unknown[] = []
  await recordGoalRunVerdicts(
    {
      organizationId: 'org1',
      resourceType: 'agent',
      resourceId: 'agent1',
      runId: 'run2',
      verdict: 'no_change',
      evidence: '',
    },
    {
      linkedGoalIds: async () => ['g1'],
      createVerdict: async () => {},
      goalState: async () => ({ name: 'G', status: 'active', riskLevel: 'off_track', ownerUserId: 'u1', createdByUserId: null }),
      recentVerdicts: async () => [
        { verdict: 'no_change', runId: 'run2' },
        { verdict: 'advanced', runId: 'run1' },
      ],
      escalate: async (input) => {
        escalated.push(input)
      },
    },
  )
  assert.equal(escalated.length, 0)
})

test('recordGoalRunVerdicts persists an unclear verdict (it counts in totals) but never escalates on it', async () => {
  const created: unknown[] = []
  const escalated: unknown[] = []
  await recordGoalRunVerdicts(
    { organizationId: 'o', resourceType: 'agent', resourceId: 'a', runId: 'r', verdict: 'unclear', evidence: '' },
    {
      linkedGoalIds: async () => ['g1'],
      createVerdict: async (row) => {
        created.push(row)
      },
      goalState: async () => ({ name: 'G', status: 'active', riskLevel: 'off_track', ownerUserId: 'u1', createdByUserId: null }),
      recentVerdicts: async () => [
        { verdict: 'unclear', runId: 'r' },
        { verdict: 'no_change', runId: 'r0' },
      ],
      escalate: async (input) => {
        escalated.push(input)
      },
    },
  )
  assert.equal(created.length, 1)
  assert.equal(escalated.length, 0)
})
