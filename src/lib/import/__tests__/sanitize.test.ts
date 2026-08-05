import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { remapAgentRefs, sanitizeImportedGraph } from '../sanitize'

function graphWith(nodes: FlowGraph['nodes'], edges: FlowGraph['edges'] = []): FlowGraph {
  return { nodes, edges }
}

test('strips webhook secrets from the trigger node', () => {
  const { graph } = sanitizeImportedGraph(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook', webhookSecretHash: 'h', webhookSecretEnc: 'e', path: 'x' } } },
  ]))
  const trigger = graph.nodes[0] as Extract<FlowGraph['nodes'][number], { type: 'trigger' }>
  const data = trigger.data.trigger as Record<string, unknown>
  assert.equal(data.webhookSecretHash, undefined)
  assert.equal(data.webhookSecretEnc, undefined)
  assert.equal(data.path, 'x')
})

test('renames a mislabeled trigger node to id "trigger" and remaps edges', () => {
  const { graph } = sanitizeImportedGraph(graphWith(
    [
      { id: 'start-7', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'a', type: 'stop', data: {} },
    ],
    [{ id: 'e1', source: 'start-7', target: 'a' }],
  ))
  assert.equal(graph.nodes[0].id, 'trigger')
  assert.equal(graph.edges[0].source, 'trigger')
})

test('clears foreign tool connection ids but keeps portable ones', () => {
  const { graph, warnings } = sanitizeImportedGraph(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 't1', type: 'tool', data: { connectionId: 'cmb1xyzforeign', toolName: 'send' } },
    { id: 't2', type: 'tool', data: { connectionId: 'nango:slack', toolName: 'slack_post_message' } },
    { id: 't3', type: 'tool', data: { connectionId: 'template:slack', toolName: 'slack_post_message' } },
  ]))
  const [, t1, t2, t3] = graph.nodes as Array<Extract<FlowGraph['nodes'][number], { type: 'tool' }>>
  assert.equal(t1.data.connectionId, '')
  assert.equal(t2.data.connectionId, 'nango:slack')
  assert.equal(t3.data.connectionId, 'template:slack')
  assert.equal(warnings.filter((w) => w.includes('another workspace')).length, 1)
})

test('drops http credentialId and foreign http connectionId', () => {
  const { graph, warnings } = sanitizeImportedGraph(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'h1', type: 'http', data: { url: 'https://api.example.com', method: 'GET', credentialId: 'cred_foreign', connectionId: 'cmbforeign' } },
  ]))
  const http = graph.nodes[1] as Extract<FlowGraph['nodes'][number], { type: 'http' }>
  assert.equal(http.data.credentialId, undefined)
  assert.equal(http.data.connectionId, undefined)
  assert.ok(warnings.length >= 1)
})

test('clears subflow flowId', () => {
  const { graph, warnings } = sanitizeImportedGraph(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 's1', type: 'subflow', data: { flowId: 'someforeignflow' } },
  ]))
  const sub = graph.nodes[1] as Extract<FlowGraph['nodes'][number], { type: 'subflow' }>
  assert.equal(sub.data.flowId, '')
  assert.ok(warnings.some((w) => w.includes('another flow')))
})

test('deduplicates colliding node ids and follows edges', () => {
  const { graph } = sanitizeImportedGraph(graphWith(
    [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'a', type: 'stop', data: {} },
      { id: 'a', type: 'stop', data: {} },
    ],
    [{ id: 'e1', source: 'trigger', target: 'a' }],
  ))
  const ids = graph.nodes.map((node) => node.id)
  assert.equal(new Set(ids).size, 3)
  // The FIRST occurrence keeps the id, so existing edges still point at it.
  assert.equal(graph.edges[0].target, 'a')
})

test('remapAgentRefs replaces mapped refs and clears unmapped ones', () => {
  const { graph, clearedRefs } = remapAgentRefs(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'g1', type: 'agent', data: { agentId: 'ref-1' } },
    { id: 'g2', type: 'agent', data: { agentId: 'ref-2' } },
    { id: 'g3', type: 'agent', data: { agentId: '', prompt: 'inline' } },
  ]), { 'ref-1': 'new-id-1' })
  const [, g1, g2, g3] = graph.nodes as Array<Extract<FlowGraph['nodes'][number], { type: 'agent' }>>
  assert.equal(g1.data.agentId, 'new-id-1')
  assert.equal(g2.data.agentId, '')
  assert.equal(g3.data.agentId, '')
  assert.deepEqual(clearedRefs, ['ref-2'])
})
