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

// ── MCP portability through template: placeholders ───────────────────────────
// Templates cannot ship raw MCP row ids (per-org, non-portable), but a
// `template:<name>` placeholder binds to an MCP connection whose NAME matches
// at provision time — the catalog includes the MCP plane, and MCP catalog ids
// are the raw row id (no prefix), which is exactly what the executor expects.

const MCP_CATALOG = [
  { id: 'cmqa_mcp_row_id_123', name: 'QA Tools', tools: [{ name: 'qa_echo', description: '', inputSchema: {} }] },
] as never[]

test('template: placeholder binds to a same-named MCP connection, yielding its raw row id', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'm', type: 'tool', data: { connectionId: 'template:qatools', toolName: 'qa_echo', args: '{}' } },
    ],
    edges: [],
  }
  const { graph: bound, bindings } = resolveGraphToolConnections(graph, MCP_CATALOG)
  const node = bound.nodes.find((n) => n.id === 'm') as any
  assert.equal(node.data.connectionId, 'cmqa_mcp_row_id_123', 'bound to the raw MCP row id')
  assert.equal(node.data.toolName, 'qa_echo')
  assert.deepEqual(bindings, [{ provider: 'qatools', connectionId: 'cmqa_mcp_row_id_123', connectionName: 'QA Tools' }])
})

test('pre-flight treats a same-named MCP connection as satisfying the requirement', () => {
  assert.deepEqual(missingRequiredProviders(['qatools'], MCP_CATALOG), [])
  assert.deepEqual(missingRequiredProviders(['qatools'], []), ['qatools'])
})

// A native Slack workspace connection is displayed as "Slack — <team>", so
// name-slug matching alone cannot satisfy a template's `slack` requirement.
// Matching must consult the catalog entry's provider id when present —
// otherwise every Slack-requiring template refuses to provision for orgs on
// the native-bot path (the 2026-08-01 flows parity audit hit exactly this).
const NATIVE_SLACK_CATALOG = [
  { id: 'native:slack', name: 'Slack — Acme', provider: 'slack', tools: [{ name: 'post_message', description: '', inputSchema: {} }] },
] as never[]

test('pre-flight and binding match a team-suffixed native connection by provider id', () => {
  assert.deepEqual(missingRequiredProviders(['slack'], NATIVE_SLACK_CATALOG), [])
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 's', type: 'tool', data: { connectionId: 'template:slack', toolName: 'post_message', args: '{}' } },
    ],
    edges: [],
  }
  const { graph: bound } = resolveGraphToolConnections(graph, NATIVE_SLACK_CATALOG)
  assert.equal((bound.nodes.find((n) => n.id === 's') as any).data.connectionId, 'native:slack')
})
