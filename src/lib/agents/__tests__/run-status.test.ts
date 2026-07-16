import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCancellableRunStatus, isTerminalRunStatus, isWaitingRunStatus } from '../run-status'

test('isCancellableRunStatus: running and waiting states are cancellable', () => {
  assert.equal(isCancellableRunStatus('running'), true)
  assert.equal(isCancellableRunStatus('waiting_for_input'), true)
})

test('isCancellableRunStatus: terminal and pending states are not cancellable', () => {
  assert.equal(isCancellableRunStatus('completed'), false)
  assert.equal(isCancellableRunStatus('failed'), false)
  assert.equal(isCancellableRunStatus('cancelled'), false)
  assert.equal(isCancellableRunStatus('cancelling'), false)
  assert.equal(isCancellableRunStatus('pending'), false)
})

test('isWaitingRunStatus: only the waiting-on-user state', () => {
  assert.equal(isWaitingRunStatus('waiting_for_input'), true)
  assert.equal(isWaitingRunStatus('running'), false)
  assert.equal(isWaitingRunStatus('completed'), false)
})

test('isTerminalRunStatus: completed, failed, cancelled are terminal', () => {
  assert.equal(isTerminalRunStatus('completed'), true)
  assert.equal(isTerminalRunStatus('failed'), true)
  assert.equal(isTerminalRunStatus('cancelled'), true)
})

test('isTerminalRunStatus: active/paused/cancelling states are not terminal', () => {
  assert.equal(isTerminalRunStatus('running'), false)
  assert.equal(isTerminalRunStatus('pending'), false)
  assert.equal(isTerminalRunStatus('waiting_for_input'), false)
  assert.equal(isTerminalRunStatus('cancelling'), false)
})
