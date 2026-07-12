import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inputParamsFromGraph, outputFieldsFromGraph, flowInputJsonSchema, flowToolSlug, isAgentCallableFlow } from '../flow-tool'
import { parseFlowToolConnectionId, formatFlowToolConnectionId } from '../tool-connection-id'
import { toolName } from '@/features/agents/tool-planes'
import type { FlowGraph } from '@/lib/flows/graph'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'in', type: 'input', data: { params: [
      { name: 'account', type: 'string', required: true, description: 'account name' },
      { name: 'limit', type: 'number' },
    ] } },
    { id: 'out', type: 'output', data: { fields: [{ name: 'score', type: 'number', value: '{{step.a.output.score}}' }] } },
  ],
  edges: [],
}

test('inputParamsFromGraph / outputFieldsFromGraph read the I/O nodes', () => {
  assert.deepEqual(inputParamsFromGraph(graph).map((p) => p.name), ['account', 'limit'])
  assert.deepEqual(outputFieldsFromGraph(graph), [{ name: 'score', type: 'number' }])
  assert.deepEqual(inputParamsFromGraph({ nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }), [])
})

test('flowInputJsonSchema derives a typed JSON Schema with required', () => {
  assert.deepEqual(flowInputJsonSchema(inputParamsFromGraph(graph)), {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'account name' },
      limit: { type: 'number' },
    },
    required: ['account'],
  })
})

test('flowToolSlug + connection id round-trips the flow plane', () => {
  assert.equal(flowToolSlug('Score Account!'), 'score_account')
  const id = formatFlowToolConnectionId('flow', 'flw_1')
  assert.equal(id, 'flow:flw_1')
  assert.deepEqual(parseFlowToolConnectionId(id), { plane: 'flow', ref: 'flw_1' })
})

test('isAgentCallableFlow reads the org opt-in', () => {
  assert.equal(isAgentCallableFlow({ agentCallable: true }), true)
  assert.equal(isAgentCallableFlow({ agentCallable: false }), false)
  assert.equal(isAgentCallableFlow(null), false)
})

test('agent flow tool name = flow_<slug>', () => {
  assert.equal(toolName('flow', flowToolSlug('Score Account')), 'flow_score_account')
})
