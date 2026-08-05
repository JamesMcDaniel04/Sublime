import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { fromN8nWorkflow } from '../n8n'

type NodeOf<T extends FlowGraph['nodes'][number]['type']> = Extract<FlowGraph['nodes'][number], { type: T }>

/** Realistic n8n export: webhook → if → (http | slack), plus a sticky note. */
const FIXTURE = {
  name: 'Lead router',
  nodes: [
    { parameters: { path: 'lead' }, id: 'n-hook', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    {
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [{ leftValue: '={{ $json.score }}', rightValue: 50, operator: { type: 'number', operation: 'larger' } }],
        },
      },
      id: 'n-if', name: 'Qualified?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [200, 0],
    },
    {
      parameters: {
        method: 'POST', url: 'https://api.crm.example/leads',
        sendHeaders: true, headerParameters: { parameters: [{ name: 'X-Team', value: 'sales' }] },
        sendBody: true, jsonBody: '={{ JSON.stringify($json) }}',
      },
      id: 'n-http', name: 'Create CRM lead', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, -100],
    },
    { parameters: { channel: '#leads', text: 'low score' }, id: 'n-slack', name: 'Notify Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [400, 100] },
    { parameters: { content: 'docs' }, id: 'n-note', name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 300] },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Qualified?', type: 'main', index: 0 }]] },
    'Qualified?': {
      main: [
        [{ node: 'Create CRM lead', type: 'main', index: 0 }],
        [{ node: 'Notify Slack', type: 'main', index: 0 }],
      ],
    },
  },
  settings: {},
}

test('converts the fixture: trigger, condition with branches, http, slack stub', () => {
  const imported = fromN8nWorkflow(JSON.parse(JSON.stringify(FIXTURE)))
  assert.equal(imported.source, 'n8n')
  assert.equal(imported.name, 'Lead router')
  assert.equal(imported.trigger.type, 'webhook')

  const byId = new Map(imported.graph.nodes.map((node) => [node.id, node]))
  const trigger = byId.get('trigger')
  assert.equal(trigger?.type, 'trigger')

  const condition = imported.graph.nodes.find((node) => node.type === 'condition') as NodeOf<'condition'>
  assert.equal(condition.data.label, 'Qualified?')
  assert.deepEqual(condition.data.clauses, [{ left: '={{ $json.score }}', op: 'gt', right: '50' }])

  const http = imported.graph.nodes.find((node) => node.type === 'http' && node.data.url) as NodeOf<'http'>
  assert.equal(http.data.method, 'POST')
  assert.equal(http.data.url, 'https://api.crm.example/leads')

  // Slack is an integration node → http stub, reported.
  assert.equal(imported.stubbedNodes.length, 1)
  assert.equal(imported.stubbedNodes[0].originalType, 'n8n-nodes-base.slack')
  const stub = byId.get(imported.stubbedNodes[0].nodeId) as NodeOf<'http'>
  assert.equal(stub.type, 'http')
  assert.equal(stub.data.label, 'Notify Slack')
  assert.ok(stub.data.note?.includes('n8n-nodes-base.slack'))

  // Sticky note dropped without a stub.
  assert.equal(imported.graph.nodes.length, 4)

  // Branch wiring: if output 0 → 'true', output 1 → 'false'.
  const trueEdge = imported.graph.edges.find((edge) => edge.source === condition.id && edge.target === http.id)
  const falseEdge = imported.graph.edges.find((edge) => edge.source === condition.id && edge.target === stub.id)
  assert.equal(trueEdge?.branch, 'true')
  assert.equal(falseEdge?.branch, 'false')

  // Layout carried across.
  assert.deepEqual(imported.graph.layout?.[condition.id], { x: 200, y: 0 })

  // Expressions were detected and warned about once.
  assert.ok(imported.warnings.some((warning) => warning.includes('expression')))
})

test('a workflow without a trigger gets a manual trigger wired to entry nodes', () => {
  const imported = fromN8nWorkflow({
    name: 'headless',
    nodes: [{ parameters: {}, id: 'n1', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0] }],
    connections: {},
  })
  assert.equal(imported.trigger.type, 'manual')
  assert.ok(imported.graph.nodes.some((node) => node.id === 'trigger'))
  assert.deepEqual(
    imported.graph.edges.map((edge) => [edge.source, edge.target]),
    [['trigger', 'n1']],
  )
})

test('merge and noOp nodes are dropped and rewired through', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: {}, id: 'n-noop', name: 'NoOp', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [100, 0] },
      { parameters: { amount: 5, unit: 'minutes' }, id: 'n-wait', name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [200, 0] },
    ],
    connections: {
      Manual: { main: [[{ node: 'NoOp', type: 'main', index: 0 }]] },
      NoOp: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
    },
  })
  assert.deepEqual(
    imported.graph.edges.map((edge) => [edge.source, edge.target]),
    [['trigger', 'n-wait']],
  )
  const wait = imported.graph.nodes.find((node) => node.type === 'wait') as NodeOf<'wait'>
  assert.equal(wait.data.amount, 5)
  assert.equal(wait.data.unit, 'minutes')
})

test('core mappings: code, set, switch, stopAndError, respondToWebhook, executeWorkflow, splitInBatches, langchain agent', () => {
  const nodes = [
    { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
    { parameters: { jsCode: 'return items', mode: 'runOnceForEachItem' }, id: 'n-code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] },
    { parameters: { assignments: { assignments: [{ id: 'a1', name: 'greeting', value: 'hello', type: 'string' }] } }, id: 'n-set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0] },
    { parameters: { rules: { values: [{ outputKey: 'big', conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.n }}', rightValue: 10, operator: { type: 'number', operation: 'larger' } }] } }] } }, id: 'n-switch', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 3, position: [0, 0] },
    { parameters: { errorMessage: 'boom' }, id: 'n-stop', name: 'Stop', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [0, 0] },
    { parameters: { respondWith: 'json', responseBody: '{"ok":true}' }, id: 'n-resp', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0] },
    { parameters: { workflowId: 'wf-far-away' }, id: 'n-sub', name: 'Run other', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.1, position: [0, 0] },
    { parameters: { batchSize: 10 }, id: 'n-batch', name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [0, 0] },
    { parameters: { text: 'You are a helpful bot' }, id: 'n-ai', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.7, position: [0, 0] },
  ]
  const imported = fromN8nWorkflow({ nodes, connections: {} })
  const byId = new Map(imported.graph.nodes.map((node) => [node.id, node]))

  const code = byId.get('n-code') as NodeOf<'code'>
  assert.equal(code.type, 'code')
  assert.equal(code.data.code, 'return items')
  assert.equal(code.data.mode, 'eachItem')

  const set = byId.get('n-set') as NodeOf<'transform'>
  assert.equal(set.type, 'transform')
  assert.deepEqual(set.data.fields, [{ name: 'greeting', value: 'hello' }])

  const sw = byId.get('n-switch') as NodeOf<'switch'>
  assert.equal(sw.type, 'switch')
  assert.equal(sw.data.cases.length, 1)
  assert.equal(sw.data.cases[0].op, 'gt')

  assert.equal((byId.get('n-stop') as NodeOf<'stop'>).data.reason, 'boom')
  assert.equal(byId.get('n-resp')?.type, 'respondWebhook')

  const sub = byId.get('n-sub') as NodeOf<'subflow'>
  assert.equal(sub.type, 'subflow')
  assert.equal(sub.data.flowId, '')

  assert.equal(byId.get('n-batch')?.type, 'loop')

  const ai = byId.get('n-ai') as NodeOf<'agent'>
  assert.equal(ai.type, 'agent')
  assert.equal(ai.data.agentId, '')
  assert.equal(ai.data.prompt, 'You are a helpful bot')

  // No integration stubs in this set — everything above maps natively.
  assert.equal(imported.stubbedNodes.length, 0)
})

test('round-trips our own n8n export back into a flow', async () => {
  const { toN8nWorkflow } = await import('@/lib/export/n8n')
  const { toPortableFlow } = await import('@/lib/export/portable')
  const portable = toPortableFlow(
    {
      name: 'RT', description: '', trigger: { type: 'manual' },
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
          { id: 'call', type: 'http', data: { label: 'Call API', method: 'GET', url: 'https://api.example.com/v1/data' } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
      },
    },
    [], '2026-08-05T00:00:00.000Z',
  )
  const imported = fromN8nWorkflow(toN8nWorkflow(portable) as unknown)
  assert.equal(imported.trigger.type, 'manual')
  const http = imported.graph.nodes.find((node) => node.type === 'http') as NodeOf<'http'>
  assert.equal(http.data.url, 'https://api.example.com/v1/data')
  assert.equal(imported.graph.edges.length, 1)
})
