import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentSessionRouting } from '../session'

const session = { agentTaskId: 'agt_1', agentRequestId: 'req_1', agentExecutionId: 'exec_1', status: 'open' }
const route = (over: Partial<Parameters<typeof resolveAgentSessionRouting>[0]>) =>
  resolveAgentSessionRouting({ session, requestStatus: 'completed', executionStatus: 'completed', agentActive: true, ...over })

test('a reply while the run is asking a question resumes that run', () => {
  assert.deepEqual(route({ requestStatus: 'waiting', executionStatus: 'waiting_for_input' }), {
    mode: 'resume', executionId: 'exec_1', requestId: 'req_1',
  })
})

test('a message after the request settled is a follow-up seeded from the completed run', () => {
  assert.deepEqual(route({}), { mode: 'continue', agentTaskId: 'agt_1', continueExecutionId: 'exec_1' })
})

test('a follow-up after a FAILED or DECLINED run starts fresh — never seeded from a broken transcript', () => {
  // A failed run can end on a dangling tool_use; seeding from it hands the
  // model a malformed conversation. Same rule the flow path applies.
  assert.equal(route({ requestStatus: 'failed', executionStatus: 'failed' }).mode, 'continue')
  assert.equal((route({ requestStatus: 'failed', executionStatus: 'failed' }) as { continueExecutionId: string | null }).continueExecutionId, null)
  assert.equal((route({ requestStatus: 'declined', executionStatus: 'completed' }) as { continueExecutionId: string | null }).continueExecutionId, 'exec_1')
})

test('a busy agent falls through — no second ask queues behind an unanswered one', () => {
  assert.equal(route({ requestStatus: 'running', executionStatus: 'running' }).mode, 'fallthrough')
  assert.equal(route({ requestStatus: 'pending', executionStatus: 'pending' }).mode, 'fallthrough')
})

test('waiting request with a waiting run but no known execution cannot resume', () => {
  assert.equal(route({ session: { ...session, agentExecutionId: null }, requestStatus: 'waiting', executionStatus: 'waiting_for_input' }).mode, 'fallthrough')
})

test('an inactive agent, a closed session, or a flow-owned session fall through', () => {
  assert.equal(route({ agentActive: false }).mode, 'fallthrough')
  assert.equal(route({ session: { ...session, status: 'closed' } }).mode, 'fallthrough')
  assert.equal(route({ session: { ...session, agentTaskId: null, agentRequestId: null } }).mode, 'fallthrough')
  assert.equal(resolveAgentSessionRouting({ session: null, requestStatus: null, executionStatus: null, agentActive: true }).mode, 'fallthrough')
})
