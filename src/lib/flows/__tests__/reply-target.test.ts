import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveReplyTarget } from '../reply-target'
import { deriveRunWaiting } from '../run-waiting'

const waitingInput = { nodeId: 'n2', kind: 'input' as const, question: 'Which region?' }

test('waiting run + input kind + live step resumes the flow', () => {
  assert.equal(resolveReplyTarget({ status: 'waiting' }, { nodeId: 'n2' }, waitingInput), 'flow')
})

test('a run that is no longer waiting falls through to the bare agent resume', () => {
  // Resumed elsewhere...
  assert.equal(resolveReplyTarget({ status: 'running' }, { nodeId: 'n2' }, null), 'agent')
  assert.equal(resolveReplyTarget({ status: 'succeeded' }, { nodeId: 'n2' }, null), 'agent')
  // ...or terminally swept: an ABANDONED execution can go waiting_for_input
  // inside a run that already failed — the zombie agent may still finish.
  assert.equal(resolveReplyTarget({ status: 'failed' }, { nodeId: 'n2' }, null), 'agent')
})

test('no flow step means a pure agent run', () => {
  assert.equal(resolveReplyTarget(null, null, null), 'agent')
  assert.equal(resolveReplyTarget({ status: 'waiting' }, null, waitingInput), 'agent')
})

test('a step that is not the live waiting step falls through', () => {
  // The run re-paused on a DIFFERENT node; replying to this stale execution
  // must not resume the flow past someone else's pause.
  assert.equal(resolveReplyTarget({ status: 'waiting' }, { nodeId: 'n1' }, waitingInput), 'agent')
  // No live waiting step derivable at all.
  assert.equal(resolveReplyTarget({ status: 'waiting' }, { nodeId: 'n2' }, null), 'agent')
})

test('composes with deriveRunWaiting: last waiting row wins', () => {
  const steps = [
    { nodeId: 'n1', status: 'succeeded' },
    { nodeId: 'n2', status: 'waiting', output: { waiting: { kind: 'input', question: 'Which region?' } } },
  ]
  const waiting = deriveRunWaiting('waiting', steps)
  assert.equal(resolveReplyTarget({ status: 'waiting' }, { nodeId: 'n2' }, waiting), 'flow')
  assert.equal(resolveReplyTarget({ status: 'waiting' }, { nodeId: 'n1' }, waiting), 'agent')
})
