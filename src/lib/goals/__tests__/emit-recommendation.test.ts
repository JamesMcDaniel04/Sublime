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
  direction: 'increase',
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
  const calls: Record<string, unknown[]> = {
    create: [],
    notify: [],
    plans: [],
    superseded: [],
  }
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
    benchmark: async () => null,
    seeds,
    findOpenPlan: async () => null,
    supersedePlan: async (id: string) => {
      calls.superseded.push(id)
    },
    createPlan: async (data: unknown) => {
      calls.plans.push(data)
      return { id: 'plan-1' }
    },
    listSources: async () => [],
    goalTemplateSourcesFor: () => ['stripe'],
    draft: async () => ({
      diagnosis: 'Behind pace since week 3.',
      actions: [{ kind: 'manual_step', refId: null, title: 'Review pipeline', rationale: 'r' }],
    }),
    ...overrides,
  }
}

/** deps() variant that forces the legacy rule-based path. */
const legacyDeps = (overrides: Record<string, unknown> = {}) =>
  deps({
    draft: async () => {
      throw new Error('drafting unavailable')
    },
    ...overrides,
  })

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

test('successful draft persists a plan and the suggestion points at it', async () => {
  const d = deps()
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, true)
  assert.equal(d.calls.plans.length, 1)
  const plan = d.calls.plans[0] as {
    triggerRiskLevel: string
    evidence: string[]
    actions: Array<{ payload: Record<string, unknown> }>
  }
  assert.equal(plan.triggerRiskLevel, 'off_track')
  assert.ok(plan.evidence.some((line) => line.includes('behind pace')))
  const created = d.calls.create[0] as {
    kind: string
    description: string
    metadata: { planId: string; seedKey: string | null }
  }
  assert.equal(created.kind, 'goal_action')
  assert.equal(created.description, 'Behind pace since week 3.')
  assert.equal(created.metadata.planId, 'plan-1')
  assert.equal(created.metadata.seedKey, null)
  assert.equal(d.calls.notify.length, 1)
})

test('draft failure falls back to the legacy rule-based suggestion', async () => {
  const d = legacyDeps()
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, true)
  assert.equal(d.calls.plans.length, 0)
  const created = d.calls.create[0] as {
    metadata: { seedKey: string | null; planId?: string }
  }
  assert.equal(created.metadata.seedKey, 'pipeline-reviver')
  assert.equal(created.metadata.planId, undefined)
  assert.equal(d.calls.notify.length, 1)
})

test('an open plan at the same risk level blocks re-emission', async () => {
  const d = deps({
    findOpenPlan: async () => ({ id: 'plan-0', triggerRiskLevel: 'off_track' }),
  })
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, false)
  assert.equal(result.reason, 'open-plan')
  assert.equal(d.calls.plans.length, 0)
  assert.equal(d.calls.superseded.length, 0)
})

test('worsening past an open at_risk plan supersedes and regenerates', async () => {
  const d = deps({
    findOpenPlan: async () => ({ id: 'plan-0', triggerRiskLevel: 'at_risk' }),
  })
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, true)
  assert.deepEqual(d.calls.superseded, ['plan-0'])
  assert.equal(d.calls.plans.length, 1)
})

test('launch_agent and connect_tool drafts persist kind-shaped payloads', async () => {
  const d = deps({
    draft: async () => ({
      diagnosis: 'd',
      actions: [
        { kind: 'connect_tool', refId: 'stripe', title: 'Connect Stripe', rationale: 'r' },
        { kind: 'launch_agent', refId: 'pipeline-reviver', title: 'Deploy reviver', rationale: 'r' },
      ],
    }),
  })
  await emitGoalRecommendation(goal, offTrack, d as never)
  const plan = d.calls.plans[0] as {
    actions: Array<{ kind: string; payload: Record<string, unknown>; rank: number }>
  }
  assert.deepEqual(plan.actions[0].payload, { source: 'stripe' })
  assert.deepEqual(plan.actions[1].payload, { seedKey: 'pipeline-reviver' })
  assert.deepEqual(
    plan.actions.map((action) => action.rank),
    [0, 1],
  )
})

test('dedupe: an open goal suggestion blocks a fallback re-emission', async () => {
  const d = legacyDeps({ findOpen: async () => ({ id: 'sug-0' }) })
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, false)
  assert.equal(result.reason, 'pending-suggestion')
  assert.equal(d.calls.create.length, 0)
})

test('no tagged template produces a plain-action fallback suggestion', async () => {
  const d = legacyDeps({ seeds: [] })
  const result = await emitGoalRecommendation(
    { ...goal, kind: 'savings' },
    offTrack,
    d as never,
  )
  assert.equal(result.emitted, true)
  const created = d.calls.create[0] as { metadata: { seedKey: string | null } }
  assert.equal(created.metadata.seedKey, null)
})

test('personal goal addresses the owner, not the creator', async () => {
  const d = deps()
  await emitGoalRecommendation({ ...goal, ownerUserId: 'user-9' }, offTrack, d as never)
  assert.equal((d.calls.create[0] as { userId: string }).userId, 'user-9')
})

test('surfaced benchmark is appended as anonymous evidence on both paths', async () => {
  const benchmark = async () => ({
    orgCount: 5,
    settledCount: 8,
    achievedCount: 5,
    topSeedKeys: [],
  })
  const planned = deps({ benchmark })
  await emitGoalRecommendation(goal, offTrack, planned as never)
  const plannedCreated = planned.calls.create[0] as { evidence: string[] }
  assert.ok(plannedCreated.evidence.some((line) => line.includes('Across 5 teams')))
  assert.ok(plannedCreated.evidence.some((line) => line.includes('63%')))

  const legacy = legacyDeps({ benchmark })
  await emitGoalRecommendation(goal, offTrack, legacy as never)
  const legacyCreated = legacy.calls.create[0] as { evidence: string[] }
  assert.ok(legacyCreated.evidence.some((line) => line.includes('Across 5 teams')))
})
