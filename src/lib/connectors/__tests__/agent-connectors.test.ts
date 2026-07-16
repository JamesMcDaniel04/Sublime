import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyConnector } from '../agent-connectors'

const connections = new Map<string, string>([
  ['jira archive', 'conn_jira'],
  ['notion', 'conn_notion'],
])

test('built-in / nango keys classify by registry kind, no FK', () => {
  assert.deepEqual(classifyConnector('Slack', connections), { connectorKey: 'Slack', kind: 'builtin', mcpConnectionId: null })
  assert.deepEqual(classifyConnector('gmail', connections), { connectorKey: 'gmail', kind: 'nango', mcpConnectionId: null })
})

test('a key naming a per-org MCP connection resolves to an FK', () => {
  assert.deepEqual(classifyConnector('Jira Archive', connections), { connectorKey: 'Jira Archive', kind: 'mcp', mcpConnectionId: 'conn_jira' })
  assert.deepEqual(classifyConnector('notion', connections), { connectorKey: 'notion', kind: 'mcp', mcpConnectionId: 'conn_notion' })
})

test('an unknown key is external, no FK', () => {
  assert.deepEqual(classifyConnector('github', connections), { connectorKey: 'github', kind: 'external', mcpConnectionId: null })
})

test('connectorKey is preserved verbatim so runtime matching is unchanged', () => {
  assert.equal(classifyConnector('my-slack-workspace', connections).connectorKey, 'my-slack-workspace')
  // still classified as a built-in Slack plane via substring match
  assert.equal(classifyConnector('my-slack-workspace', connections).kind, 'builtin')
})
