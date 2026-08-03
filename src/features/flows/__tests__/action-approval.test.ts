import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  flowActionNeedsApproval,
  flowActionApprovalQuestion,
  resolveFlowActionApproval,
} from '../action-approval'

test('only an explicit node opt-in gates a step', () => {
  assert.equal(flowActionNeedsApproval({ requireApproval: true }), true)
  // Un-flagged steps run as before — gating every write would pause every
  // existing flow at every POST.
  assert.equal(flowActionNeedsApproval({ method: 'POST' }), false)
  assert.equal(flowActionNeedsApproval({}), false)
  // Only a real boolean true opts in; a stray truthy string does not.
  assert.equal(flowActionNeedsApproval({ requireApproval: 'yes' }), false)
  assert.equal(flowActionNeedsApproval({ requireApproval: false }), false)
})

test('the approval question names the target and previews the payload', () => {
  const question = flowActionApprovalQuestion({
    kind: 'http',
    label: 'Issue refund',
    config: { method: 'post', url: 'https://api.example.com/refunds', body: { amount: 4200 } },
  })
  assert.match(question, /Issue refund/)
  assert.match(question, /POST https:\/\/api\.example\.com\/refunds/)
  assert.match(question, /4200/)
  assert.match(question, /approve/i)
})

test('the approval question redacts credential-shaped config', () => {
  const question = flowActionApprovalQuestion({
    kind: 'http',
    config: {
      method: 'POST',
      url: 'https://api.example.com/x',
      headers: { authorization: 'Bearer sk-live-supersecretvalue', 'x-api-key': 'abcd1234' },
      body: { note: 'fine' },
    },
  })
  assert.ok(!question.includes('sk-live-supersecretvalue'), 'bearer token must not reach the prompt')
  assert.ok(!question.includes('abcd1234'), 'api key must not reach the prompt')
  assert.match(question, /\[redacted\]/)
  assert.match(question, /fine/)
})

test('tool steps name the tool rather than a URL', () => {
  const question = flowActionApprovalQuestion({
    kind: 'tool',
    label: 'Delete records',
    config: { toolName: 'crm.bulk_delete', args: { ids: [1, 2, 3] } },
  })
  assert.match(question, /crm\.bulk_delete/)
  assert.match(question, /Delete records/)
})

test('an unpreviewable payload still produces a question', () => {
  const circular: Record<string, unknown> = { toolName: 't' }
  circular.args = circular
  const question = flowActionApprovalQuestion({ kind: 'tool', config: circular })
  assert.match(question, /Approval required/)
})

test('approval is deny-by-default', () => {
  assert.deepEqual(resolveFlowActionApproval('approve'), { approved: true })
  assert.deepEqual(resolveFlowActionApproval('  yes  '), { approved: true })

  // Missing, empty, and qualified replies all cancel.
  for (const reply of [undefined, null, '', '   ', 'no', 'yes but change the amount', 'approve the other one']) {
    const decision = resolveFlowActionApproval(reply)
    assert.equal(decision.approved, false, `expected "${reply}" to deny`)
  }
})

test('a denial surfaces the user words as the step error', () => {
  const decision = resolveFlowActionApproval('no — wrong customer')
  assert.equal(decision.approved, false)
  assert.ok(!decision.approved && decision.error.includes('wrong customer'))
})
