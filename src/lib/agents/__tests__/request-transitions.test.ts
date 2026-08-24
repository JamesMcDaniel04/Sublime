import test from 'node:test'
import assert from 'node:assert/strict'
import { isTerminal, refuseTransition, REQUEST_STATUSES, sourcesFor, type RequestStatus } from '../request-transitions'

test('a queued request may start, be cancelled, or fail before it ever runs', () => {
  assert.equal(refuseTransition('pending', 'running'), null)
  assert.equal(refuseTransition('pending', 'cancelled'), null)
  // Enqueue can fail (budget refused, agent archived) before a worker claims it.
  assert.equal(refuseTransition('pending', 'failed'), null)
})

test('a running request may pause for the requester and resume', () => {
  assert.equal(refuseTransition('running', 'waiting'), null)
  assert.equal(refuseTransition('waiting', 'running'), null)
})

test('a running or waiting request may reach any settled state', () => {
  for (const from of ['running', 'waiting'] as const) {
    for (const to of ['completed', 'failed', 'declined', 'cancelled'] as const) {
      assert.equal(refuseTransition(from, to), null, `${from} -> ${to}`)
    }
  }
})

test('a request cannot answer before it runs', () => {
  // Nothing has executed, so there is no answer to record.
  const refusal = refuseTransition('pending', 'completed')
  assert.ok(refusal, 'must be refused')
  assert.match(refusal, /has not run/i)
})

test('a request cannot decline before it runs', () => {
  // Declining is a judgment the agent makes IN the run, via decline_request.
  assert.ok(refuseTransition('pending', 'declined'))
})

test('settled is terminal — a redelivered job cannot resurrect a request', () => {
  // This is what makes settleAgentRequest idempotent: BullMQ can redeliver a
  // job whose row already settled, and that must be a no-op rather than a
  // second answer overwriting the first.
  for (const from of ['completed', 'failed', 'declined', 'cancelled'] as const) {
    for (const to of REQUEST_STATUSES) {
      const refusal = refuseTransition(from, to)
      assert.ok(refusal, `${from} -> ${to} must be refused`)
      assert.match(refusal, /already settled/i)
    }
  }
})

test('a no-op transition to the same non-terminal status is allowed', () => {
  // A resumed run re-claims `running`; that must not error.
  assert.equal(refuseTransition('running', 'running'), null)
})

test('unknown statuses are refused by name', () => {
  const refusal = refuseTransition('running', 'sideways' as RequestStatus)
  assert.ok(refusal)
  assert.match(refusal, /sideways/)
})

test('isTerminal marks exactly the settled statuses', () => {
  assert.deepEqual(
    REQUEST_STATUSES.filter(isTerminal),
    ['completed', 'failed', 'declined', 'cancelled'],
  )
})

test('sourcesFor derives the SQL guard from the same rules', () => {
  // The settle path uses this as `status: { in: ... }`, so it must never
  // include a terminal status — that is what makes settling idempotent.
  assert.deepEqual(sourcesFor('completed'), ['running', 'waiting'])
  assert.deepEqual(sourcesFor('declined'), ['running', 'waiting'])
  assert.deepEqual(sourcesFor('running'), ['pending', 'running', 'waiting'])
  assert.deepEqual(sourcesFor('failed'), ['pending', 'running', 'waiting'])
  assert.deepEqual(sourcesFor('cancelled'), ['pending', 'running', 'waiting'])
})

test('no terminal status is ever a source', () => {
  for (const to of REQUEST_STATUSES) {
    for (const from of sourcesFor(to)) {
      assert.equal(isTerminal(from), false, `${from} must not be a source for ${to}`)
    }
  }
})
