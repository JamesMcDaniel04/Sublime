import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRunWaiting } from '../run-waiting'

test('returns null for non-waiting runs even if a step is waiting', () => {
  assert.equal(deriveRunWaiting('succeeded', [{ nodeId: 'a', status: 'waiting' }]), null)
  assert.equal(deriveRunWaiting('failed', []), null)
  assert.equal(deriveRunWaiting('running', [{ nodeId: 'a', status: 'running' }]), null)
})

test('returns null when a waiting run has no waiting step', () => {
  assert.equal(deriveRunWaiting('waiting', [{ nodeId: 'a', status: 'succeeded' }]), null)
})

test('derives an input pause with its question', () => {
  const steps = [
    { nodeId: 'a', status: 'succeeded', output: 'done' },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'input', question: 'Which account?' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'input', question: 'Which account?' })
})

test('derives an approval pause', () => {
  const steps = [{ nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'approval', approvalId: 'ap_1' } } }]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'approval', question: undefined })
})

test('defaults to input when the waiting info is missing or malformed', () => {
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting' }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: null }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: 'a summary string' }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'bogus' } } }]), { nodeId: 'b', kind: 'input', question: undefined })
})

test('derives a durable time pause with wakeAt', () => {
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'wait', status: 'waiting', output: { waiting: { kind: 'time', wakeAt: '2030-01-01T00:00:00.000Z' } } }]), { nodeId: 'wait', kind: 'time', question: undefined, wakeAt: '2030-01-01T00:00:00.000Z' })
})

test('picks the latest waiting step when multiple are waiting', () => {
  const steps = [
    { nodeId: 'a', status: 'waiting', output: { waiting: { kind: 'approval' } } },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'input', question: 'q' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'input', question: 'q' })
})

test('resume then re-pause: the resolved old row is ignored, the new pause wins', () => {
  // First run paused on node a; resume resolved that row to 'resumed', the
  // re-run created new rows, and a later node b paused again.
  const steps = [
    { nodeId: 'a', status: 'resumed', output: { waiting: { kind: 'input', question: 'old question' } } },
    { nodeId: 'a', status: 'succeeded', output: 'answered' },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'input', question: 'new question' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'input', question: 'new question' })
})

test('stale unresolved waiting row (legacy run): the latest pause still wins', () => {
  // Legacy resumes never resolved the old waiting row — both rows say waiting,
  // but the later one (higher order) is the live pause.
  const steps = [
    { nodeId: 'a', status: 'waiting', output: { waiting: { kind: 'input', question: 'old question' } } },
    { nodeId: 'a', status: 'succeeded', output: 'answered' },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'approval', approvalId: 'ap_2' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'approval', question: undefined })
})
