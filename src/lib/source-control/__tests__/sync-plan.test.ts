/**
 * Deciding what a push or pull would actually change.
 *
 * Computed BEFORE anything is written, so both directions can be previewed.
 * Source control that applies changes you did not see is worse than none: the
 * whole reason to put flows in a repository is that somebody reviews the
 * change first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushPlan, pullPlan } from '../sync-plan'
import { flowFileContent, flowFilePath } from '../flow-file'

const flowA = { id: 'a1', name: 'Alpha', description: '', trigger: { type: 'manual' }, graph: { nodes: [], edges: [] } }
const flowB = { id: 'b2', name: 'Beta', description: '', trigger: { type: 'manual' }, graph: { nodes: [], edges: [] } }

const remoteOf = (...flows: typeof flowA[]) =>
  flows.map((flow) => ({ path: flowFilePath(flow), content: flowFileContent(flow), sha: `sha-${flow.id}` }))

// ── pushing ─────────────────────────────────────────────────────────────────

test('a flow missing from the repository is created', () => {
  const plan = pushPlan([flowA], [])
  assert.deepEqual(plan.map((entry) => entry.action), ['create'])
  assert.equal(plan[0].path, flowFilePath(flowA))
})

// The property the deterministic serializer exists to make possible.
test('an unchanged flow produces no change at all', () => {
  assert.deepEqual(pushPlan([flowA], remoteOf(flowA)), [])
})

test('a modified flow is an update carrying the sha it is replacing', () => {
  const plan = pushPlan([{ ...flowA, name: 'Alpha renamed' }], remoteOf(flowA))
  // A rename changes the path, so this is a create at the new path plus a
  // delete of the old one — which is exactly how it should read in review.
  assert.ok(plan.some((entry) => entry.action === 'create'))
  assert.ok(plan.some((entry) => entry.action === 'delete' && entry.sha === 'sha-a1'))
})

test('an edit that does not rename is a plain update', () => {
  const edited = { ...flowA, description: 'now documented' }
  const plan = pushPlan([edited], remoteOf(flowA))
  assert.deepEqual(plan.map((entry) => entry.action), ['update'])
  assert.equal(plan[0].sha, 'sha-a1', 'an update must carry the sha it replaces')
})

// Without the sha, the GitHub API would either refuse the write or clobber a
// change someone else pushed in between.
test('a create carries no sha', () => {
  assert.equal(pushPlan([flowA], [])[0].sha, undefined)
})

// A flow deleted locally is NOT deleted from the repository by a push. The
// repository is the history; silently erasing it on a routine push is how
// source control loses work.
test('a flow absent locally is left alone rather than deleted', () => {
  const plan = pushPlan([flowA], remoteOf(flowA, flowB))
  assert.equal(plan.length, 0, 'a push deleted a flow that only exists in the repository')
})

test('several flows are planned together', () => {
  const plan = pushPlan([flowA, flowB], [])
  assert.equal(plan.length, 2)
})

// ── pulling ─────────────────────────────────────────────────────────────────

test('a flow only in the repository is created locally', () => {
  const plan = pullPlan([], remoteOf(flowA))
  assert.deepEqual(plan.map((entry) => entry.action), ['create'])
  assert.equal(plan[0].flowId, 'a1')
})

test('an unchanged flow pulls nothing', () => {
  assert.deepEqual(pullPlan([flowA], remoteOf(flowA)), [])
})

test('a flow changed in the repository is an update', () => {
  const plan = pullPlan([flowA], remoteOf({ ...flowA, description: 'changed upstream' }))
  assert.deepEqual(plan.map((entry) => entry.action), ['update'])
  assert.equal(plan[0].flowId, 'a1')
})

// Identity is the id INSIDE the file, so a flow renamed in the repository
// updates the existing flow instead of creating a duplicate.
test('a renamed flow updates rather than duplicating', () => {
  const plan = pullPlan([flowA], remoteOf({ ...flowA, name: 'Alpha Renamed' }))
  assert.equal(plan.length, 1)
  assert.equal(plan[0].action, 'update')
  assert.equal(plan[0].flowId, 'a1')
})

// A local flow that is not in the repository is not deleted by a pull, for the
// same reason a push does not delete: nobody expects a sync to destroy work.
test('a local-only flow is left alone by a pull', () => {
  const plan = pullPlan([flowA, flowB], remoteOf(flowA))
  assert.equal(plan.length, 0)
})

test('a file that is not one of ours is ignored', () => {
  const plan = pullPlan([], [
    { path: 'README.md', content: '# hello', sha: 's1' },
    { path: 'flows/broken.json', content: '{not json', sha: 's2' },
  ])
  assert.deepEqual(plan, [])
})

test('the parsed flow travels with the plan so applying needs no re-parse', () => {
  const plan = pullPlan([], remoteOf(flowA))
  assert.equal(plan[0].flow?.name, 'Alpha')
})
