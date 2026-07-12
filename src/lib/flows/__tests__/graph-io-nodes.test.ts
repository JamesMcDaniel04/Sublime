import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, emptyGraph } from '../graph'

test('flowGraphSchema parses an input node with typed params', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'in', type: 'input', data: { params: [
        { name: 'account', type: 'string', required: true },
        { name: 'limit', type: 'number', default: '10', description: 'max rows' },
      ] } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const inNode = parsed.success && parsed.data.nodes.find((n) => n.type === 'input')
  assert.ok(inNode && inNode.type === 'input')
  assert.equal(inNode.data.params[0].name, 'account')
  assert.equal(inNode.data.params[0].required, true)
})

test('flowGraphSchema parses output and subflow nodes', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'flw_1', input: '{"account":"{{input.account}}"}' } },
      { id: 'out', type: 'output', data: { fields: [{ name: 'score', type: 'number', value: '{{step.sub.output.score}}' }] } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const out = parsed.success && parsed.data.nodes.find((n) => n.type === 'output')
  assert.ok(out && out.type === 'output')
  assert.equal(out.data.fields[0].type, 'number')
})

test('back-compat: emptyGraph and a legacy trigger.inputFields graph still parse', () => {
  assert.equal(flowGraphSchema.safeParse(emptyGraph()).success, true)
  const legacy = flowGraphSchema.safeParse({
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual', inputFields: [{ name: 'q', type: 'string', required: true }] } } }],
    edges: [],
  })
  assert.equal(legacy.success, true)
})
