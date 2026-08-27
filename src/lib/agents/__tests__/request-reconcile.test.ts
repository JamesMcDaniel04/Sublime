import test from 'node:test'
import assert from 'node:assert/strict'
import { ORPHAN_REQUEST_TIMEOUT_MS, planRequestReconciliation } from '../request-reconcile'

const now = new Date('2026-08-27T12:00:00Z')
const req = (over: Partial<Parameters<typeof planRequestReconciliation>[0][number]> = {}) => ({
  id: 'req_1', organizationId: 'org_1', status: 'running', executionId: 'exec_1',
  createdAt: new Date(now.getTime() - 60_000), ...over,
})
const execs = (status: string, error: string | null = null) =>
  new Map([['exec_1', { id: 'exec_1', status, error }]])

test('a failed run fails the request with the run error', () => {
  const [move] = planRequestReconciliation([req()], execs('failed', 'boom'), now)
  assert.equal(move.to, 'failed')
  assert.equal(move.error, 'boom')
})

test('a failed run with no error text still gives the requester a reason', () => {
  const [move] = planRequestReconciliation([req()], execs('failed'), now)
  assert.equal(move.to, 'failed')
  assert.ok(move.error)
})

test('a cancelled run cancels the request', () => {
  assert.equal(planRequestReconciliation([req()], execs('cancelled'), now)[0].to, 'cancelled')
})

test('a completed run that never settled its request completes it', () => {
  // The crash window between the completion claim and the settle write.
  assert.equal(planRequestReconciliation([req()], execs('completed'), now)[0].to, 'completed')
})

test('a run parked on a human moves the request to waiting — once', () => {
  assert.equal(planRequestReconciliation([req()], execs('waiting_for_input'), now)[0].to, 'waiting')
  assert.equal(planRequestReconciliation([req()], execs('waiting_for_approval'), now)[0].to, 'waiting')
  // Already waiting: nothing to do, no churn.
  assert.deepEqual(planRequestReconciliation([req({ status: 'waiting' })], execs('waiting_for_input'), now), [])
})

test('a resumed run moves a waiting request back to running', () => {
  assert.equal(planRequestReconciliation([req({ status: 'waiting' })], execs('running'), now)[0].to, 'running')
})

test('a run parked on an external agent reads as working, not as needing the requester', () => {
  assert.equal(planRequestReconciliation([req({ status: 'waiting' })], execs('waiting_for_external'), now)[0].to, 'running')
  assert.deepEqual(planRequestReconciliation([req({ status: 'running' })], execs('waiting_for_external'), now), [])
})

test('a queued run is left alone — it will run', () => {
  assert.deepEqual(planRequestReconciliation([req({ status: 'pending' })], execs('pending'), now), [])
})

test('a request already settled is never touched', () => {
  for (const status of ['completed', 'failed', 'declined', 'cancelled']) {
    assert.deepEqual(planRequestReconciliation([req({ status })], execs('failed', 'x'), now), [])
  }
})

test('a run pruned by retention fails the request rather than stranding it', () => {
  const [move] = planRequestReconciliation([req()], new Map(), now)
  assert.equal(move.to, 'failed')
  assert.match(move.error!, /no longer exists/)
})

test('a request with no run yet is left alone until the orphan timeout', () => {
  const fresh = req({ executionId: null, status: 'pending', createdAt: new Date(now.getTime() - 5 * 60_000) })
  assert.deepEqual(planRequestReconciliation([fresh], new Map(), now), [])
  const old = req({ executionId: null, status: 'pending', createdAt: new Date(now.getTime() - ORPHAN_REQUEST_TIMEOUT_MS - 1) })
  const [move] = planRequestReconciliation([old], new Map(), now)
  assert.equal(move.to, 'failed')
  assert.match(move.error!, /never started/)
})
