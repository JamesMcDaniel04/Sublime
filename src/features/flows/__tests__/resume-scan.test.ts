import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveResumeState, type PriorStepRow } from '../resume-scan'

function row(partial: Partial<PriorStepRow> & Pick<PriorStepRow, 'nodeId' | 'status'>): PriorStepRow {
  return {
    output: null,
    agentExecutionId: null,
    iterationPath: null,
    ...partial,
  }
}

test('prefers the inner leaf over its enclosing loop\'s own waiting row', () => {
  const priorSteps: PriorStepRow[] = [
    row({ nodeId: 'agentA', status: 'succeeded', output: 'first-iter-output' }),
    row({ nodeId: 'agentA', status: 'waiting', agentExecutionId: 'exec_1' }),
    row({ nodeId: 'loop1', status: 'waiting' }),
  ]
  const nodeTypeById = new Map([['agentA', 'agent'], ['loop1', 'loop']])
  const state = resolveResumeState(priorSteps, nodeTypeById)
  assert.equal(state.resumeNodeId, 'agentA')
  assert.equal(state.resumeExecutionId, 'exec_1')
})

test('nested containers: leaf under errorShield under loop still wins', () => {
  const priorSteps: PriorStepRow[] = [
    row({ nodeId: 'toolLeaf', status: 'waiting', agentExecutionId: null }),
    row({ nodeId: 'shield1', status: 'waiting' }),
    row({ nodeId: 'loop1', status: 'waiting' }),
  ]
  const nodeTypeById = new Map([['toolLeaf', 'tool'], ['shield1', 'errorShield'], ['loop1', 'loop']])
  const state = resolveResumeState(priorSteps, nodeTypeById)
  assert.equal(state.resumeNodeId, 'toolLeaf')
})

test('normal (non-container) pause is unaffected', () => {
  const priorSteps: PriorStepRow[] = [
    row({ nodeId: 'a', status: 'succeeded', output: 'done' }),
    row({ nodeId: 'b', status: 'waiting', agentExecutionId: 'exec_9' }),
  ]
  const nodeTypeById = new Map([['a', 'agent'], ['b', 'humanReview']])
  const state = resolveResumeState(priorSteps, nodeTypeById)
  assert.equal(state.resumeNodeId, 'b')
  assert.equal(state.resumeExecutionId, 'exec_9')
})

test('a paused subflow step surfaces its child run id for the resume to forward into', () => {
  const priorSteps: PriorStepRow[] = [
    row({ nodeId: 'sub', status: 'waiting', childFlowRunId: 'child_run_1' }),
    row({ nodeId: 'loop1', status: 'waiting' }),
  ]
  const nodeTypeById = new Map([['sub', 'subflow'], ['loop1', 'loop']])
  const state = resolveResumeState(priorSteps, nodeTypeById)
  assert.equal(state.resumeNodeId, 'sub')
  assert.equal(state.resumeChildFlowRunId, 'child_run_1')
})

test('BACK-COMPAT: succeeded/skipped steps build the completed map keyed by nodeId when there is no iterationPath', () => {
  const priorSteps: PriorStepRow[] = [
    row({ nodeId: 'a', status: 'succeeded', output: 'first' }),
    row({ nodeId: 'b', status: 'skipped', output: 'second' }),
  ]
  const state = resolveResumeState(priorSteps, new Map())
  assert.deepEqual(state.completed, { a: 'first', b: 'second' })
})

test('a loop-body step\'s iterationPath disambiguates the completed map key', () => {
  const priorSteps: PriorStepRow[] = [
    row({ nodeId: 'a', status: 'succeeded', output: 'iter0-out', iterationPath: '0' }),
    row({ nodeId: 'a', status: 'succeeded', output: 'iter1-out', iterationPath: '1' }),
  ]
  const state = resolveResumeState(priorSteps, new Map())
  assert.deepEqual(state.completed, { 'a#i:0': 'iter0-out', 'a#i:1': 'iter1-out' })
})
