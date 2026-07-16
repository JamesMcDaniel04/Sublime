import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isApprovalReply, toolNeedsApproval, approvalQuestion } from '../approval'

test('isApprovalReply: explicit affirmatives approve', () => {
  for (const reply of ['approve', 'Approved', ' yes ', 'y', 'ok', 'OK!', 'okay', 'confirm', 'Confirmed.', 'proceed', 'go ahead', 'lgtm', 'do it', 'send it']) {
    assert.equal(isApprovalReply(reply), true, `"${reply}" should approve`)
  }
})

test('isApprovalReply: anything else denies (deny-by-default)', () => {
  for (const reply of ['no', 'deny', 'denied', 'stop', '', '   ', 'approve the other one instead', 'yes but change the subject line', 'not yet']) {
    assert.equal(isApprovalReply(reply), false, `"${reply}" should deny`)
  }
  assert.equal(isApprovalReply(undefined), false)
  assert.equal(isApprovalReply(null), false)
})

test('toolNeedsApproval: gated only when the agent opted in AND the provider is a write plane', () => {
  // Opt-in off: nothing is gated, whatever the provider.
  assert.equal(toolNeedsApproval({ requireApproval: false, provider: 'slack' }), false)
  assert.equal(toolNeedsApproval({ requireApproval: false, provider: 'nango:gmail' }), false)

  // Opt-in on: every write plane is gated — including the HTTP builtin the
  // old audit regex missed, and all nango:* delivery planes.
  for (const provider of ['slack', 'email', 'http', 'nango:slack', 'nango:gmail', 'nango:salesforce']) {
    assert.equal(toolNeedsApproval({ requireApproval: true, provider }), true, `${provider} must be gated`)
  }

  // Read planes and internal tools never pause.
  for (const provider of ['granola', 'agent', 'flow', 'read', undefined, null]) {
    assert.equal(toolNeedsApproval({ requireApproval: true, provider }), false, `${provider} must not be gated`)
  }
})

test('approvalQuestion: names the tool, includes bounded input, asks for "approve"', () => {
  const q = approvalQuestion('slack.post_message', { channel: '#general', text: 'hi' })
  assert.ok(q.includes('slack.post_message'))
  assert.ok(q.includes('#general'))
  assert.ok(/approve/i.test(q))

  const huge = approvalQuestion('email.send', { body: 'x'.repeat(10_000) })
  assert.ok(huge.length < 1_500, 'question stays bounded for huge inputs')
})
