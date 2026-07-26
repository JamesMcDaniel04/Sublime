import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emitGoalRecommendation, renderGoalEvidence } from '../emit-recommendation'
import type { Evaluation } from '../evaluate'

const goal = {
  id: 'goal-1',
  organizationId: 'org-1',
  ownerUserId: null,
  createdByUserId: 'user-1',
  name: 'Q4 ARR target',
  kind: 'arr',
  unit: 'usd',
  targetValue: 2_000_000,
  targetDate: new Date('2026-12-31T00:00:00Z'),
  startAt: new Date('2026-07-01T00:00:00Z'),
  startValue: 1_200_000,
}
const offTrack: Evaluation = {
  currentValue: 1_300_000,
  progress: 0.125,
  expectedProgress: 0.5,
  projectedValue: 1_500_000,
  riskLevel: 'off_track',
}

const seeds = [
  {
    seedKey: 'pipeline-reviver',
    name: 'Pipeline Reviver',
    description: 'd',
    departments: ['sales'],
    requiredIntegrations: [],
    recommendedIntegrations: [],
    kind: 'flow',
    goalKinds: ['arr'],
    estimatedMinutesSaved: 30,
  },
] as never[]

function deps(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = { create: [], notify: [] }
  return {
    calls,
    findOpen: async () => null,
    createSuggestion: async (data: unknown) => {
      calls.create.push(data)
      return { id: 'sug-1' }
    },
    notifyFn: async (input: unknown) => {
      calls.notify.push(input)
      return null
    },
    adoptionScores: async () => ({}),
    seeds,
    ...overrides,
  }
}

test('evidence lines cite value vs pace and projection vs target', () => {
  const lines = renderGoalEvidence({
    name: goal.name,
    unit: 'usd',
    currentValue: 1_300_000,
    targetValue: 2_000_000,
    expectedValue: 1_600_000,
    projectedValue: 1_500_000,
    targetDate: goal.targetDate,
  })
  assert.ok(lines.some((line) => line.includes('behind pace')))
  assert.ok(lines.some((line) => line.includes('projected')))
})

test('emits a goal_action suggestion with template metadata and notifies', async () => {
  const d = deps()
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, true)
  const created = d.calls.create[0] as {
    kind: string
    userId: string
    metadata: { goalId: string; seedKey: string | null }
  }
  assert.equal(created.kind, 'goal_action')
  assert.equal(created.userId, 'user-1')
  assert.equal(created.metadata.goalId, 'goal-1')
  assert.equal(created.metadata.seedKey, 'pipeline-reviver')
  assert.equal(d.calls.notify.length, 1)
})

test('dedupe: an open goal suggestion for this goal blocks re-emission', async () => {
  const d = deps({ findOpen: async () => ({ id: 'sug-0' }) })
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, false)
  assert.equal(d.calls.create.length, 0)
})

test('no tagged template produces a plain-action suggestion', async () => {
  const d = deps({ seeds: [] })
  const result = await emitGoalRecommendation({ ...goal, kind: 'savings' }, offTrack, d as never)
  assert.equal(result.emitted, true)
  const created = d.calls.create[0] as { metadata: { seedKey: string | null } }
  assert.equal(created.metadata.seedKey, null)
})

test('personal goal addresses the owner, not the creator', async () => {
  const d = deps()
  await emitGoalRecommendation({ ...goal, ownerUserId: 'user-9' }, offTrack, d as never)
  assert.equal((d.calls.create[0] as { userId: string }).userId, 'user-9')
})
