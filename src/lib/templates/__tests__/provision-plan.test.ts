import { test } from 'node:test'
import assert from 'node:assert/strict'
import { graphNeedsBackingFlow, missingRequiredProviders, resolveGraphToolConnections, rewriteGraphAgentRefs } from '../provision-plan'
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

test('graphNeedsBackingFlow: http node or multiple tool steps need a real flow', () => {
  // trigger -> agent -> single delivery tool: collapses cleanly to an agent.
  assert.equal(graphNeedsBackingFlow(g), false)
  // trigger -> agent only: no tools, no backing flow.
  assert.equal(graphNeedsBackingFlow({ nodes: g.nodes.slice(0, 2), edges: [] }), false)
  // an http (enrichment) node → needs a flow, even alone.
  assert.equal(graphNeedsBackingFlow({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'h', type: 'http', data: { connectionId: 'http:default', method: 'GET', url: 'https://api.example.com', headers: {}, body: '' } },
    ] as FlowGraph['nodes'],
    edges: [],
  }), true)
  // two tool steps (enrich write + notify) → multi-step orchestration.
  assert.equal(graphNeedsBackingFlow({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 't1', type: 'tool', data: { connectionId: 'template:salesforce', toolName: 'create_record', args: '{}' } },
      { id: 't2', type: 'tool', data: { connectionId: 'native:slack', toolName: 'post_message', args: '{}' } },
    ] as FlowGraph['nodes'],
    edges: [],
  }), true)
})

test('template tool placeholders prefer Nango and adopt its discovered tool name', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'sf', type: 'tool', data: { connectionId: 'template:salesforce', toolName: 'salesforce_create_record', args: '{}' } }],
    edges: [],
  }
  const { graph: out, bindings } = resolveGraphToolConnections(graph, [
    { id: 'cmcpsfrow', name: 'Salesforce', tools: [{ name: 'create_record', description: '' }] },
    { id: 'nango:salesforce', name: 'Salesforce', tools: [{ name: 'salesforce_create_record', description: '' }] },
  ])
  const node = out.nodes[0] as any
  assert.equal(node.data.connectionId, 'nango:salesforce')
  assert.equal(node.data.toolName, 'salesforce_create_record')
  assert.deepEqual(bindings, [{ provider: 'salesforce', connectionId: 'nango:salesforce', connectionName: 'Salesforce' }])
})

test('binding is deterministic across same-plane duplicates and honors overrides', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'sf', type: 'tool', data: { connectionId: 'template:salesforce', toolName: 'create_record', args: '{}' } }],
    edges: [],
  }
  const catalog = [
    { id: 'nango:salesforce-b', name: 'Salesforce', tools: [{ name: 'create_record', description: '' }] },
    { id: 'nango:salesforce-a', name: 'Salesforce', tools: [{ name: 'create_record', description: '' }] },
  ]
  // Deterministic default: stable by id, regardless of catalog order.
  const first = resolveGraphToolConnections(graph, catalog)
  const second = resolveGraphToolConnections(graph, [...catalog].reverse())
  assert.equal((first.graph.nodes[0] as any).data.connectionId, 'nango:salesforce-a')
  assert.equal((second.graph.nodes[0] as any).data.connectionId, 'nango:salesforce-a')
  // Explicit override pins the other account.
  const overridden = resolveGraphToolConnections(graph, catalog, { salesforce: 'nango:salesforce-b' })
  assert.equal((overridden.graph.nodes[0] as any).data.connectionId, 'nango:salesforce-b')
})

test('missingRequiredProviders matches the binding pass (present vs absent)', () => {
  const catalog = [{ id: 'nango:salesforce', name: 'Salesforce', tools: [{ name: 'create_record', description: '' }] }]
  assert.deepEqual(missingRequiredProviders(['salesforce', 'hubspot'], catalog), ['hubspot'])
  assert.deepEqual(missingRequiredProviders(['salesforce'], catalog), [])
})

test('template tool placeholders fail clearly when the integration is disconnected', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'sf', type: 'tool', data: { connectionId: 'template:salesforce', toolName: 'create_record', args: '{}' } }],
    edges: [],
  }
  assert.throws(() => resolveGraphToolConnections(graph, []), /Connect salesforce/)
  assert.deepEqual(missingRequiredProviders(['salesforce'], []), ['salesforce'])
})
