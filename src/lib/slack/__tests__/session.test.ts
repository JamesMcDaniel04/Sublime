import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSessionRouting } from '@/lib/slack/session'

const session = { flowId: 'f1', flowRunId: 'run1', agentExecutionId: 'exec1', status: 'open' }

test('no session, or a closed one → fallthrough to normal matching', () => {
  assert.deepEqual(resolveSessionRouting({ session: null, runStatus: null, flowActive: true }), { mode: 'fallthrough' })
  assert.deepEqual(resolveSessionRouting({ session: { ...session, status: 'closed' }, runStatus: 'waiting', flowActive: true }), { mode: 'fallthrough' })
})

test('unpublished/inactive flow → fallthrough (caller closes the session)', () => {
  assert.deepEqual(resolveSessionRouting({ session, runStatus: 'waiting', flowActive: false }), { mode: 'fallthrough' })
})

test('waiting run → the message is the reply (resume)', () => {
  assert.deepEqual(resolveSessionRouting({ session, runStatus: 'waiting', flowActive: true }), { mode: 'resume', flowRunId: 'run1', flowId: 'f1' })
})

test('settled run → new run continuing the conversation (seed = last agent execution)', () => {
  assert.deepEqual(resolveSessionRouting({ session, runStatus: 'succeeded', flowActive: true }), { mode: 'continue', flowId: 'f1', continueExecutionId: 'exec1' })
  // no agent execution recorded yet → still route to the session's flow, fresh conversation
  assert.deepEqual(
    resolveSessionRouting({ session: { ...session, agentExecutionId: null }, runStatus: 'failed', flowActive: true }),
    { mode: 'continue', flowId: 'f1' },
  )
  // run row vanished → still continue by flow
  assert.deepEqual(resolveSessionRouting({ session, runStatus: null, flowActive: true }), { mode: 'continue', flowId: 'f1', continueExecutionId: 'exec1' })
})
