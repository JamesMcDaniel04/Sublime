import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { flowGraphSchema } from '../graph'
import { normalizeGeneratedFlowGraphInput, repairGeneratedFlowGraph, validationIssuesForModel } from '../copilot'
import { validateFlowGraph } from '../validate'
import { graphRules } from '../copilot-grounding'

test('normalizeGeneratedFlowGraphInput coerces common model-shaped config values before schema parse', () => {
  const normalized = normalizeGeneratedFlowGraphInput({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual', inputFields: [{ name: 'count', type: 'integer' }] } } },
      { id: 'call', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: { channel: 'C1', text: 'Hello' }, retries: '2', timeoutSeconds: '15', outputFields: [{ name: 'id', type: 'integer' }] } },
      { id: 'webhook', type: 'http', data: { method: 'post', url: 'https://example.com', query: { page: 1 }, headers: { authorization: 'Bearer token' }, retries: '1', body: { ok: true } } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'call', branch: 1 }],
  })
  const parsed = flowGraphSchema.parse(normalized)
  const trigger = parsed.nodes.find((node) => node.id === 'trigger')
  const tool = parsed.nodes.find((node) => node.id === 'call')
  const http = parsed.nodes.find((node) => node.id === 'webhook')
  assert.equal(trigger?.type === 'trigger' ? trigger.data.trigger.inputFields[0].type : '', 'number')
  assert.equal(tool?.type === 'tool' ? tool.data.args : '', JSON.stringify({ channel: 'C1', text: 'Hello' }, null, 2))
  assert.equal(tool?.type === 'tool' ? tool.data.retries : undefined, 2)
  assert.equal(tool?.type === 'tool' ? tool.data.timeoutMs : undefined, 15000)
  assert.equal(tool?.type === 'tool' ? tool.data.outputFields?.[0]?.type : '', 'number')
  assert.equal(http?.type === 'http' ? http.data.method : '', 'POST')
  assert.equal(http?.type === 'http' ? http.data.retries : undefined, 1)
  assert.equal(http?.type === 'http' ? http.data.query : '', JSON.stringify({ page: 1 }, null, 2))
  assert.equal(parsed.edges[0].branch, '1')
})

test('repairGeneratedFlowGraph prunes unknown agents and dangling edges', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'good', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 'bad', type: 'agent', data: { agentId: 'missing', input: 'x' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'bad' },
      { id: 'e2', source: 'bad', target: 'good' },
    ],
  }
  const repaired = repairGeneratedFlowGraph(graph, { agents: [{ id: 'a1' }], toolCatalog: [] })
  assert.equal(repaired.nodes.some((node) => node.id === 'bad'), false)
  assert.equal(repaired.edges.some((edge) => edge.source === 'bad' || edge.target === 'bad'), false)
  assert.ok(repaired.edges.some((edge) => edge.source === 'trigger' && edge.target === 'good'))
})

test('repairGeneratedFlowGraph prunes unavailable tools and container references', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['keep', 'drop'] } },
      { id: 'keep', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{}' } },
      { id: 'drop', type: 'tool', data: { connectionId: 'c1', toolName: 'missing', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  }
  const repaired = repairGeneratedFlowGraph(graph, {
    agents: [],
    toolCatalog: [{ id: 'c1', tools: [{ name: 'send' }] }],
  })
  const loop = repaired.nodes.find((node) => node.id === 'loop')
  assert.deepEqual(loop?.type === 'loop' ? loop.data.body : [], ['keep'])
  assert.equal(repaired.nodes.some((node) => node.id === 'drop'), false)
})

test('repairGeneratedFlowGraph maps missing required tool args to named trigger inputs', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual', inputFields: [{ name: 'channel', type: 'string', description: 'Slack channel' }] } } },
      { id: 'send', type: 'tool', data: { connectionId: 'c1', toolName: 'send_message', args: '{broken' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'send' }],
  }
  const context = {
    agents: [],
    toolCatalog: [{
      id: 'c1',
      tools: [{
        name: 'send_message',
        inputSchema: {
          type: 'object',
          required: ['channel', 'text'],
          properties: {
            channel: { type: 'string', description: 'Slack channel' },
            text: { type: 'string', description: 'Message text' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'Created message id' },
            url: { type: 'string' },
          },
        },
      }],
    }],
  }
  const repaired = repairGeneratedFlowGraph(graph, context)
  const trigger = repaired.nodes.find((node) => node.type === 'trigger')
  const tool = repaired.nodes.find((node) => node.id === 'send')
  assert.deepEqual(trigger?.type === 'trigger' ? trigger.data.trigger.inputFields : [], [
    { name: 'channel', type: 'string', description: 'Slack channel' },
    { name: 'text', type: 'string', description: 'Message text' },
  ])
  assert.deepEqual(JSON.parse(tool?.type === 'tool' ? tool.data.args ?? '{}' : '{}'), {
    channel: '{{trigger.input.channel}}',
    text: '{{trigger.input.text}}',
  })
  assert.deepEqual(tool?.type === 'tool' ? tool.data.outputFields : [], [
    { name: 'messageId', type: 'string', description: 'Created message id' },
    { name: 'url', type: 'string' },
  ])
  assert.equal(validateFlowGraph(repaired, context).ok, true)
})

test('validationIssuesForModel formats concise repair feedback', () => {
  const result = validateFlowGraph({ nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] })
  assert.match(validationIssuesForModel(result), /NO_STEPS/)
  assert.match(validationIssuesForModel(result), /Add at least one step/)
})

test('graphRules documents the new control-flow node kinds', () => {
  assert.match(graphRules, /router/)
  assert.match(graphRules, /errorShield/)
  assert.match(graphRules, /inline prompt/i)
  assert.match(graphRules, /threadAgent/)
  assert.match(graphRules, /join/)
})
