import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLOW_TOOL_PLANES,
  formatFlowToolConnectionId,
  parseFlowToolConnectionId,
  planesForConnectionIds,
} from '../tool-connection-id'

test('format/parse round-trips every plane', () => {
  const refs = {
    mcp: 'cmcpconnrow456',
    native: 'slack',
    nango: 'gmail',
    postgres: 'cpgconnrow789',
    flow: 'flw_1',
  } as const
  for (const plane of FLOW_TOOL_PLANES) {
    const id = formatFlowToolConnectionId(plane, refs[plane])
    assert.deepEqual(parseFlowToolConnectionId(id), { plane, ref: refs[plane] })
  }
})

test('mcp ids stay raw (backward compat with stored graphs)', () => {
  assert.equal(formatFlowToolConnectionId('mcp', 'cmcpconnrow456'), 'cmcpconnrow456')
  assert.deepEqual(parseFlowToolConnectionId('cmcpconnrow456'), { plane: 'mcp', ref: 'cmcpconnrow456' })
})

test('prefixed planes produce <plane>:<ref> ids', () => {
  assert.equal(formatFlowToolConnectionId('nango', 'slack'), 'nango:slack')
  assert.equal(formatFlowToolConnectionId('native', 'http'), 'native:http')
  assert.equal(formatFlowToolConnectionId('flow', 'flw_1'), 'flow:flw_1')
})

test('unknown prefixes fall back to the mcp plane with the FULL id as ref', () => {
  assert.deepEqual(parseFlowToolConnectionId('foo:bar'), { plane: 'mcp', ref: 'foo:bar' })
  assert.deepEqual(parseFlowToolConnectionId('klavis:row1'), { plane: 'mcp', ref: 'klavis:row1' })
})

test('a leading colon is not a prefix', () => {
  assert.deepEqual(parseFlowToolConnectionId(':oops'), { plane: 'mcp', ref: ':oops' })
})

test('dispatch routing: each id kind routes to its plane executor', () => {
  // The flow tool-step dispatcher routes on parse(...).plane — this pins the
  // decision for one id of every kind, including legacy raw MCP row ids.
  const routed = ['cmlegacyrawid', 'native:granola', 'nango:salesforce', 'flow:flw_1'].map(
    (id) => parseFlowToolConnectionId(id).plane,
  )
  assert.deepEqual(routed, ['mcp', 'native', 'nango', 'flow'])
})

test('planesForConnectionIds targets only the referenced planes and collects raw mcp ids', () => {
  const { planes, mcpIds } = planesForConnectionIds(['cmrawa', 'cmrawb', 'nango:slack', 'native:email'])
  assert.deepEqual([...planes].sort(), ['mcp', 'nango', 'native'].sort())
  assert.deepEqual(mcpIds, ['cmrawa', 'cmrawb'])
})

test('planesForConnectionIds with no mcp ids requests no mcp rows', () => {
  const { planes, mcpIds } = planesForConnectionIds(['nango:slack'])
  assert.deepEqual([...planes], ['nango'])
  assert.deepEqual(mcpIds, [])
})
