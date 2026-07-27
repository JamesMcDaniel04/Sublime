import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftRecoveryPlan,
  RecoveryDraftError,
  riskWorse,
  validateRecoveryDraft,
} from '../recovery'
import type { RecoveryCandidates } from '../recovery-candidates'

const candidates: RecoveryCandidates = {
  agentTemplates: [
    {
      seedKey: 'pipeline-reviver',
      name: 'Pipeline Reviver',
      description: 'd',
      requiredIntegrations: [],
    },
  ],
  sourceGaps: [{ source: 'stripe', label: 'Stripe', reason: 'goal_template_source' }],
}

const draft = (actions: unknown[]) =>
  JSON.stringify({ diagnosis: 'Pace fell behind after week 3.', actions })

test('valid draft passes through with order preserved', () => {
  const plan = validateRecoveryDraft(
    draft([
      { kind: 'connect_tool', refId: 'stripe', title: 'Connect Stripe', rationale: 'exact MRR' },
      { kind: 'launch_agent', refId: 'pipeline-reviver', title: 'Revive pipeline', rationale: 'stale deals' },
      { kind: 'manual_step', refId: null, title: 'Review pricing page', rationale: 'conversion' },
    ]),
    candidates,
  )
  assert.equal(plan.actions.length, 3)
  assert.equal(plan.diagnosis, 'Pace fell behind after week 3.')
  assert.deepEqual(
    plan.actions.map((action) => action.kind),
    ['connect_tool', 'launch_agent', 'manual_step'],
  )
})

test('actions with ids outside the candidate set are dropped', () => {
  const plan = validateRecoveryDraft(
    draft([
      { kind: 'launch_agent', refId: 'made-up-agent', title: 'x', rationale: 'y' },
      { kind: 'connect_tool', refId: 'quickbooks', title: 'x', rationale: 'y' },
      { kind: 'manual_step', refId: null, title: 'Call top accounts', rationale: 'z' },
    ]),
    candidates,
  )
  assert.deepEqual(
    plan.actions.map((action) => action.kind),
    ['manual_step'],
  )
})

test('a draft with zero surviving actions throws', () => {
  assert.throws(
    () =>
      validateRecoveryDraft(
        draft([{ kind: 'launch_agent', refId: 'nope', title: 'x', rationale: 'y' }]),
        candidates,
      ),
    RecoveryDraftError,
  )
})

test('unparseable JSON throws RecoveryDraftError', () => {
  assert.throws(() => validateRecoveryDraft('not json', candidates), RecoveryDraftError)
})

test('draftRecoveryPlan wires goal + candidates into the model call', async () => {
  let captured: { system: string; user: string } | null = null
  const plan = await draftRecoveryPlan({
    goal: {
      name: 'Q4 ARR',
      kind: 'arr',
      unit: 'usd',
      targetValue: 2_000_000,
      targetDate: new Date('2026-12-31'),
      direction: 'increase',
    },
    evidence: ['Q4 ARR: $1,300,000 is $300,000 behind pace ($1,600,000 expected by today).'],
    candidates,
    generate: async (opts) => {
      captured = { system: opts.system, user: opts.user }
      return draft([{ kind: 'manual_step', refId: null, title: 'Review pipeline', rationale: 'r' }])
    },
  })
  assert.equal(plan.actions.length, 1)
  assert.ok(captured !== null)
  assert.ok(captured!.user.includes('pipeline-reviver'))
  assert.ok(captured!.user.includes('behind pace'))
})

test('generation failure surfaces as RecoveryDraftError', async () => {
  await assert.rejects(
    draftRecoveryPlan({
      goal: {
        name: 'g',
        kind: 'arr',
        unit: 'usd',
        targetValue: 1,
        targetDate: new Date('2026-12-31'),
        direction: 'increase',
      },
      evidence: [],
      candidates,
      generate: async () => {
        throw new Error('provider down')
      },
    }),
    RecoveryDraftError,
  )
})

test('riskWorse orders off_track above at_risk only', () => {
  assert.equal(riskWorse('off_track', 'at_risk'), true)
  assert.equal(riskWorse('at_risk', 'off_track'), false)
  assert.equal(riskWorse('at_risk', 'at_risk'), false)
  assert.equal(riskWorse('off_track', 'off_track'), false)
})
