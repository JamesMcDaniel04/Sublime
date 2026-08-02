import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPlan,
  applyPlanUpdate,
  auditPlan,
  PLAN_TOOLS,
  type RunPlan,
} from '../plan-artifact'

test('createPlan numbers steps from 1 and starts them pending', () => {
  const plan = createPlan(['find leads', 'draft emails'])
  assert.deepEqual(plan, {
    steps: [
      { n: 1, title: 'find leads', status: 'pending' },
      { n: 2, title: 'draft emails', status: 'pending' },
    ],
    revisions: [],
  })
})

test('createPlan drops blank titles and caps step count', () => {
  const plan = createPlan(['  ', 'real step', ...Array.from({ length: 30 }, (_, i) => `s${i}`)])
  assert.equal(plan.steps[0].title, 'real step')
  assert.ok(plan.steps.length <= 20)
})

test('applyPlanUpdate marks a step done with a note', () => {
  const plan = createPlan(['a', 'b'])
  const next = applyPlanUpdate(plan, { stepN: 1, status: 'done', note: 'found 12', turn: 3 })
  assert.equal(next.plan!.steps[0].status, 'done')
  assert.equal(next.plan!.steps[0].note, 'found 12')
  assert.equal(next.error, undefined)
})

test('applyPlanUpdate rejects an unknown step number without mutating', () => {
  const plan = createPlan(['a'])
  const next = applyPlanUpdate(plan, { stepN: 9, status: 'done', turn: 2 })
  assert.ok(next.error)
  assert.equal(plan.steps[0].status, 'pending')
})

test('applyPlanUpdate with revisedSteps replaces later pending steps and records the revision', () => {
  const plan = createPlan(['a', 'b', 'c'])
  const afterDone = applyPlanUpdate(plan, { stepN: 1, status: 'done', turn: 2 }).plan!
  const next = applyPlanUpdate(afterDone, {
    stepN: 2,
    status: 'failed',
    note: 'API returned 403',
    revisedSteps: ['use the export endpoint instead'],
    turn: 4,
  })
  assert.equal(next.plan!.steps[0].status, 'done')
  assert.equal(next.plan!.steps[1].status, 'failed')
  assert.deepEqual(
    next.plan!.steps.slice(2).map((s) => ({ title: s.title, status: s.status })),
    [{ title: 'use the export endpoint instead', status: 'pending' }],
  )
  // Step numbers stay unique and sequential after revision.
  assert.deepEqual(next.plan!.steps.map((s) => s.n), [1, 2, 3])
  assert.deepEqual(next.plan!.revisions, [{ turn: 4, reason: 'API returned 403' }])
})

test('applyPlanUpdate only accepts explained revisions after a failed step', () => {
  const plan = createPlan(['a', 'b'])
  assert.match(
    applyPlanUpdate(plan, { stepN: 1, status: 'done', note: 'changed my mind', revisedSteps: ['c'], turn: 2 }).error ?? '',
    /only valid.*failed/i,
  )
  assert.match(
    applyPlanUpdate(plan, { stepN: 1, status: 'failed', revisedSteps: ['c'], turn: 2 }).error ?? '',
    /note explaining why/i,
  )
  assert.match(
    applyPlanUpdate(plan, { stepN: 1, status: 'failed', note: 'blocked', revisedSteps: ['  '], turn: 2 }).error ?? '',
    /non-empty step/i,
  )
  assert.equal(plan.steps[0].status, 'pending')
  assert.deepEqual(plan.revisions, [])
})

test('auditPlan: strategize run that never set a plan is the only finding', () => {
  assert.deepEqual(auditPlan(null, true), ['plan_never_set'])
  assert.deepEqual(auditPlan(null, false), [])
})

test('auditPlan flags pending leftovers and unrevised failures', () => {
  const plan: RunPlan = {
    steps: [
      { n: 1, title: 'a', status: 'done' },
      { n: 2, title: 'b', status: 'failed' },
      { n: 3, title: 'c', status: 'pending' },
    ],
    revisions: [],
  }
  assert.deepEqual(auditPlan(plan, true), ['steps_left_pending', 'failed_step_no_revision'])
})

test('auditPlan: a failure followed by a revision is clean', () => {
  const plan: RunPlan = {
    steps: [
      { n: 1, title: 'a', status: 'failed' },
      { n: 2, title: 'b', status: 'done' },
    ],
    revisions: [{ turn: 3, reason: 'switched approach' }],
  }
  assert.deepEqual(auditPlan(plan, true), [])
})

test('PLAN_TOOLS exposes set_plan and update_plan with input schemas', () => {
  const names = PLAN_TOOLS.map((tool) => tool.name)
  assert.deepEqual(names, ['set_plan', 'update_plan'])
  for (const tool of PLAN_TOOLS) {
    assert.ok(tool.description.length > 20)
    assert.equal((tool.inputSchema as { type?: string }).type, 'object')
  }
})
