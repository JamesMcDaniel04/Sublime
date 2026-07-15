import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notificationHref } from '../notification-href'

test('a jam invite deep-links STRAIGHT into the flow (not the activity page)', () => {
  // Regression: invites were typed `flow.jam.invite` and fell through to the
  // read-only /activity page (or /dashboard when executionId was missing).
  assert.equal(notificationHref({ type: 'flow.jam.invite', executionId: 'flow1' }), '/flows/flow1')
})

test('a jam notification deep-links straight into the flow', () => {
  assert.equal(notificationHref({ type: 'flow.jam', executionId: 'flow1' }), '/flows/flow1')
})

test('other flow notifications go to the flow activity page', () => {
  assert.equal(notificationHref({ type: 'flow.run.failed', executionId: 'flow1' }), '/flows/flow1/activity')
})

test('approval notifications open the decision inbox', () => {
  assert.equal(notificationHref({ type: 'agent.needs_approval', executionId: 'run1' }), '/approvals')
  assert.equal(notificationHref({ type: 'flow.needs_approval', executionId: 'flow1' }), '/approvals')
})

test('a run notification without a flow id goes to the dashboard run view', () => {
  assert.equal(notificationHref({ type: 'agent.run', executionId: 'run1' }), '/dashboard?run=run1')
})

test('a notification with no execution id falls back to the dashboard', () => {
  assert.equal(notificationHref({ type: 'flow.jam.invite', executionId: null }), '/dashboard')
})
