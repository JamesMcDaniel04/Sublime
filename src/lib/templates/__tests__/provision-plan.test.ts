import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveGraphToolConnections, rewriteGraphAgentRefs } from '../provision-plan'
import type { FlowGraph } from '@/lib/flows/graph'

const g: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'a', type: 'agent', data: { agentId: 'ref-one', input: 'x' } },
    { id: 't', type: 'tool', data: { connectionId: 'native:slack', toolName: 'post_message', args: '{}' } },
  ],
  edges: [{ id: 'e', source: 'trigger', target: 'a' }],
}

test('rewrites matching agent refs, leaves other nodes untouched, does not mutate input', () => {
  const out = rewriteGraphAgentRefs(g, { 'ref-one': 'agent_123' })
  const agent = out.nodes.find((n) => n.id === 'a')!
  assert.equal((agent as any).data.agentId, 'agent_123')
  assert.equal((g.nodes[1] as any).data.agentId, 'ref-one', 'input graph unchanged')
  assert.equal((out.nodes.find((n) => n.id === 't') as any).data.toolName, 'post_message')
})

test('throws on an unresolved agent ref', () => {
  assert.throws(() => rewriteGraphAgentRefs(g, {}), /unresolved agent/i)
})

test('template tool placeholders prefer Nango and adopt its discovered tool name', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'sf', type: 'tool', data: { connectionId: 'template:salesforce', toolName: 'salesforce_create_record', args: '{}' } }],
    edges: [],
  }
  const out = resolveGraphToolConnections(graph, [
    { id: 'cmcpsfrow', name: 'Salesforce', tools: [{ name: 'create_record', description: '' }] },
    { id: 'nango:salesforce', name: 'Salesforce', tools: [{ name: 'salesforce_create_record', description: '' }] },
  ])
  const node = out.nodes[0] as any
  assert.equal(node.data.connectionId, 'nango:salesforce')
  assert.equal(node.data.toolName, 'salesforce_create_record')
})

test('template tool placeholders fail clearly when the integration is disconnected', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'sf', type: 'tool', data: { connectionId: 'template:salesforce', toolName: 'create_record', args: '{}' } }],
    edges: [],
  }
  assert.throws(() => resolveGraphToolConnections(graph, []), /Connect salesforce/)
})
