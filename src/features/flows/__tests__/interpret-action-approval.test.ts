import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'
import { flowActionNeedsApproval, resolveFlowActionApproval } from '../action-approval'

const runAgent: RunAgentFn = async () => ({ output: 'unused' })

/** Two-step flow: a flagged http call, then a downstream step that must not run. */
function graphWithApproval(requireApproval: boolean): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'call',
        type: 'http',
        data: { method: 'POST', url: 'https://api.example.com/refunds', body: '{"amount":1}', requireApproval },
      },
      { id: 'after', type: 'agent', data: { agentId: 'a1', input: 'downstream' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'call' },
      { id: 'e1', source: 'call', target: 'after' },
    ],
  }
}

/**
 * The execute-flow adapter's approval behaviour, reproduced against the pure
 * interpreter: gate first, pause on the first visit, resolve on resume.
 */
function approvalAwareRunAction(params: { reply?: string; executed: string[] }): RunActionFn {
  return async (node) => {
    if (flowActionNeedsApproval(node.config)) {
      if (!node.resume) return { waiting: { status: 'waiting_for_input', question: 'Approval required — proceed?' } }
      const decision = resolveFlowActionApproval(params.reply)
      if (!decision.approved) return { error: decision.error }
    }
    params.executed.push(node.id)
    return { output: { ok: true } }
  }
}

test('a flagged action parks the run before it fires and blocks downstream steps', async () => {
  const executed: string[] = []
  const result = await interpretFlow(graphWithApproval(true), 'go', {
    runAgent,
    runAction: approvalAwareRunAction({ executed }),
  })

  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'call')
  assert.match(result.waiting?.question ?? '', /Approval required/)
  // The whole point: nothing fired, and the downstream step never ran.
  assert.deepEqual(executed, [])
  assert.equal(result.steps.some((step) => step.nodeId === 'after'), false)
})

test('an un-flagged action is unaffected — existing flows do not start pausing', async () => {
  const executed: string[] = []
  const result = await interpretFlow(graphWithApproval(false), 'go', {
    runAgent,
    runAction: approvalAwareRunAction({ executed }),
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(executed, ['call'])
})

test('resuming with an approval fires the held call and continues', async () => {
  const executed: string[] = []
  const result = await interpretFlow(graphWithApproval(true), 'go', {
    runAgent,
    runAction: approvalAwareRunAction({ reply: 'approve', executed }),
    resumeKey: 'call',
    resumeReply: 'approve',
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(executed, ['call'])
})

test('resuming with anything else cancels the step instead of firing it', async () => {
  const executed: string[] = []
  const result = await interpretFlow(graphWithApproval(true), 'go', {
    runAgent,
    runAction: approvalAwareRunAction({ reply: 'no, wrong customer', executed }),
    resumeKey: 'call',
    resumeReply: 'no, wrong customer',
  })

  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /approval was not granted/i)
  assert.deepEqual(executed, [], 'a denied call must never execute')
})
