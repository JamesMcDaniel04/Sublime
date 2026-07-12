import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentContinueExecutionId } from '../execute-flow'

// resolveAgentContinueExecutionId is the exact function execute-flow.ts's
// runAgent adapter calls for every agent node it reaches — these tests drive
// it the same way a two-agent-node run (or a loop-threaded run) would, node
// by node, threading the run-scoped `slackSeedRemaining` latch through calls
// exactly as the adapter does. No LLM/DB involved: this is the deterministic
// core of the "first agent step ONLY, ONCE" + "never hijack a loop thread"
// invariants.

test('first agent step of the run consumes the Slack seed', () => {
  const result = resolveAgentContinueExecutionId({
    threadContinueExecutionId: undefined,
    hasThread: false,
    withinThreadedLoop: false,
    isResume: false,
    slackSeedRemaining: true,
    slackContinueExecutionId: 'exec-seed',
  })
  assert.deepEqual(result, { continueExecutionId: 'exec-seed', consumed: true })
})

test('two-agent-node flow: seeds ONLY the first node, second node starts fresh', () => {
  let slackSeedRemaining = true
  const slackContinueExecutionId = 'exec-seed'

  // Node 1 (first agent step reached in execution order).
  const node1 = resolveAgentContinueExecutionId({
    threadContinueExecutionId: undefined,
    hasThread: false,
    withinThreadedLoop: false,
    isResume: false,
    slackSeedRemaining,
    slackContinueExecutionId,
  })
  if (node1.consumed) slackSeedRemaining = false
  assert.equal(node1.continueExecutionId, 'exec-seed')
  assert.equal(slackSeedRemaining, false, 'the latch must be exhausted after the first eligible node')

  // Node 2 (second agent step) — must NOT receive the seed a second time.
  const node2 = resolveAgentContinueExecutionId({
    threadContinueExecutionId: undefined,
    hasThread: false,
    withinThreadedLoop: false,
    isResume: false,
    slackSeedRemaining,
    slackContinueExecutionId,
  })
  assert.deepEqual(node2, { continueExecutionId: undefined, consumed: false })
})

test('a loop-thread agent (node.thread set) is NEVER hijacked by the Slack seed, even as the first node reached', () => {
  let slackSeedRemaining = true
  const slackContinueExecutionId = 'exec-seed'

  // Iteration 0 of a threaded loop — no threadContinueExecutionId yet (no
  // predecessor), but hasThread is true because it's inside a threadAgent loop.
  const threaded = resolveAgentContinueExecutionId({
    threadContinueExecutionId: undefined,
    hasThread: true,
    withinThreadedLoop: true,
    isResume: false,
    slackSeedRemaining,
    slackContinueExecutionId,
  })
  assert.deepEqual(threaded, { continueExecutionId: undefined, consumed: false })
  assert.equal(slackSeedRemaining, true, 'a skipped (loop-thread) node must NOT consume the latch')

  // The seed survives for the next ELIGIBLE (non-thread) agent node.
  const nextEligible = resolveAgentContinueExecutionId({
    threadContinueExecutionId: undefined,
    hasThread: false,
    withinThreadedLoop: false,
    isResume: false,
    slackSeedRemaining,
    slackContinueExecutionId,
  })
  assert.deepEqual(nextEligible, { continueExecutionId: 'exec-seed', consumed: true })
})

test('an agent reached via a container (parallel branch / nested loop) INSIDE a threadAgent loop is never hijacked, even though it carries no `thread` of its own', () => {
  // This is the hijack fix: interpret.ts does not set ctx.thread for an agent
  // inside a parallel branch (or nested non-threaded loop) within a
  // threadAgent loop body — only ctx.withinThreadedLoop is true there.
  // hasThread is false, but withinThreadedLoop must still block the seed.
  const result = resolveAgentContinueExecutionId({
    threadContinueExecutionId: undefined,
    hasThread: false,
    withinThreadedLoop: true,
    isResume: false,
    slackSeedRemaining: true,
    slackContinueExecutionId: 'exec-seed',
  })
  assert.deepEqual(result, { continueExecutionId: undefined, consumed: false })
})

test('loop-threading\'s own continuation always wins over the Slack seed (iteration > 0)', () => {
  const result = resolveAgentContinueExecutionId({
    threadContinueExecutionId: 'exec-prior-iteration',
    hasThread: true,
    withinThreadedLoop: true,
    isResume: false,
    slackSeedRemaining: true,
    slackContinueExecutionId: 'exec-seed',
  })
  assert.deepEqual(result, { continueExecutionId: 'exec-prior-iteration', consumed: false })
})

test('a resuming agent invocation never consumes the Slack seed', () => {
  const result = resolveAgentContinueExecutionId({
    threadContinueExecutionId: undefined,
    hasThread: false,
    withinThreadedLoop: false,
    isResume: true,
    slackSeedRemaining: true,
    slackContinueExecutionId: 'exec-seed',
  })
  assert.deepEqual(result, { continueExecutionId: undefined, consumed: false })
})

test('no Slack seed on the job: inert, never manufactures a continueExecutionId', () => {
  const result = resolveAgentContinueExecutionId({
    threadContinueExecutionId: undefined,
    hasThread: false,
    withinThreadedLoop: false,
    isResume: false,
    slackSeedRemaining: false,
    slackContinueExecutionId: undefined,
  })
  assert.deepEqual(result, { continueExecutionId: undefined, consumed: false })
})
