/**
 * "What breaks if I revoke this?"
 *
 * The credential vault knows what exists; nothing knew what DEPENDS on it. A
 * connection could be deleted and the damage discovered by a flow failing at
 * 3am — which is the failure mode n8n's credential-dependency table exists to
 * prevent.
 *
 * Half of this already worked: `collectFlowCredentialRefs` walks flow graphs
 * for the credentials tab. What was missing is the reverse direction (given a
 * ref, who uses it) and AGENTS entirely — an agent's connections live in
 * `AgentConnector` rows, which no dependency walk looked at.
 *
 * Pure over already-loaded rows, so the rule is testable without a database
 * and the same answer can back a settings page, a delete confirmation, and a
 * pre-revoke check.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialDependents, type DependencyInput } from '../credential-dependents'

const FLOW_USING_VAULT = {
  id: 'f1',
  name: 'Nightly digest',
  graph: {
    nodes: [
      { id: 'n1', type: 'http', data: { url: 'https://x', method: 'GET', authMode: 'generic', credentialId: 'cred_a' } },
    ],
    edges: [],
  },
  publishedGraph: null,
}

const FLOW_USING_CONNECTION = {
  id: 'f2',
  name: 'Slack poster',
  graph: {
    nodes: [{ id: 'n1', type: 'tool', data: { connectionId: 'nango:slack', toolName: 'post_message' } }],
    edges: [],
  },
  publishedGraph: null,
}

const input = (over: Partial<DependencyInput> = {}): DependencyInput => ({
  flows: [FLOW_USING_VAULT, FLOW_USING_CONNECTION],
  agentConnectors: [
    { agentTaskId: 'a1', agentName: 'Reporter', connectorKey: 'nango:slack', kind: 'nango', mcpConnectionId: null },
    { agentTaskId: 'a2', agentName: 'Researcher', connectorKey: 'mcp-server-1', kind: 'mcp', mcpConnectionId: 'mcp_1' },
  ],
  ...over,
})

test('a vault credential reports the flow that uses it', () => {
  const result = credentialDependents(input(), 'cred_a')
  assert.deepEqual(result.flows.map((f) => f.id), ['f1'])
  assert.equal(result.total, 1)
})

test('a connection ref reports both the flow and the agent that use it', () => {
  const result = credentialDependents(input(), 'nango:slack')
  assert.deepEqual(result.flows.map((f) => f.id), ['f2'])
  assert.deepEqual(result.agents.map((a) => a.id), ['a1'])
  assert.equal(result.total, 2)
})

// The half that was entirely missing before.
test('an agent-only dependency is still found', () => {
  const result = credentialDependents(input({ flows: [] }), 'nango:slack')
  assert.equal(result.flows.length, 0)
  assert.deepEqual(result.agents.map((a) => a.name), ['Reporter'])
})

test('an MCP connection is matched by its row id, not only its key', () => {
  const result = credentialDependents(input({ flows: [] }), 'mcp_1')
  assert.deepEqual(result.agents.map((a) => a.id), ['a2'])
})

test('an unused credential reports nothing, and says so', () => {
  const result = credentialDependents(input(), 'cred_unused')
  assert.equal(result.total, 0)
  assert.equal(result.safeToRevoke, true)
})

test('anything with a dependent is not safe to revoke', () => {
  assert.equal(credentialDependents(input(), 'cred_a').safeToRevoke, false)
})

// A published graph is what an ACTIVE flow actually runs, so a credential
// referenced only there is still load-bearing.
test('a credential used only by the published graph still counts', () => {
  const flow = {
    id: 'f3',
    name: 'Live only',
    graph: { nodes: [], edges: [] },
    publishedGraph: {
      nodes: [{ id: 'n1', type: 'http', data: { url: 'https://x', method: 'GET', authMode: 'generic', credentialId: 'cred_live' } }],
      edges: [],
    },
  }
  assert.equal(credentialDependents(input({ flows: [flow] }), 'cred_live').total, 1)
})

// A flow row can predate the current schema; a malformed graph must not take
// the whole answer down, because this backs a delete confirmation.
test('a malformed graph contributes nothing rather than throwing', () => {
  const broken = { id: 'f4', name: 'Broken', graph: 'not a graph', publishedGraph: null }
  assert.doesNotThrow(() => credentialDependents(input({ flows: [broken as never] }), 'cred_a'))
})

test('a flow is reported once even if several steps use the same credential', () => {
  const twice = {
    id: 'f5',
    name: 'Twice',
    graph: {
      nodes: [
        { id: 'n1', type: 'http', data: { url: 'https://x', method: 'GET', authMode: 'generic', credentialId: 'cred_a' } },
        { id: 'n2', type: 'http', data: { url: 'https://y', method: 'GET', authMode: 'generic', credentialId: 'cred_a' } },
      ],
      edges: [],
    },
    publishedGraph: null,
  }
  assert.equal(credentialDependents(input({ flows: [twice] }), 'cred_a').flows.length, 1)
})
