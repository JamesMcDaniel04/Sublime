/**
 * Which flows an external MCP client can see and run.
 *
 * The decision this file exists to get right: `flowCallableAsTool` defaults to
 * TRUE when unset, which is correct for INTERNAL flow-to-flow calls — a
 * workspace's own flows calling each other. It is the wrong default for an
 * external client, where the same rule would silently publish every flow in
 * the workspace to anyone holding an API key the moment this feature shipped.
 *
 * So MCP exposure is its own explicit opt-in, and it fails closed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowExposedToMcp, mcpToolsFor } from '../exposed-flows'

const base = {
  id: 'f1',
  name: 'Nightly Sync',
  description: 'Syncs things',
  metadata: { mcpExposed: true },
  publishedGraph: { nodes: [], edges: [] },
}

// ── the gate ────────────────────────────────────────────────────────────────

test('a flow is not exposed unless it says so', () => {
  assert.equal(flowExposedToMcp({ ...base, metadata: {} }), false)
  assert.equal(flowExposedToMcp({ ...base, metadata: null }), false)
  assert.equal(flowExposedToMcp({ ...base, metadata: undefined }), false)
})

test('a flow that opts in is exposed', () => {
  assert.equal(flowExposedToMcp(base), true)
})

// Fail closed on anything that is not literally true — a truthy string from a
// bad import must not read as consent.
test('only a literal true counts as opting in', () => {
  assert.equal(flowExposedToMcp({ ...base, metadata: { mcpExposed: 'yes' } }), false)
  assert.equal(flowExposedToMcp({ ...base, metadata: { mcpExposed: 1 } }), false)
})

// An unpublished flow has no reviewed version to run. Exposing the draft would
// let an external client execute an unfinished edit.
test('an unpublished flow is never exposed even if it opts in', () => {
  assert.equal(flowExposedToMcp({ ...base, publishedGraph: null }), false)
})

// The internal setting does not grant external exposure by itself...
test('being internally callable does not expose a flow externally', () => {
  assert.equal(flowExposedToMcp({ ...base, metadata: { callerPolicy: 'any' } }), false)
})

// ...and refusing internal calls must not be overridden by the MCP opt-in.
test('a flow that refuses callers is not exposed despite opting in', () => {
  assert.equal(flowExposedToMcp({ ...base, metadata: { mcpExposed: true, callerPolicy: 'none' } }), false)
})

// ── building the tool list ──────────────────────────────────────────────────

test('an exposed flow becomes a tool', () => {
  const tools = mcpToolsFor([base])
  assert.equal(tools.length, 1)
  assert.equal(tools[0].flowId, 'f1')
  assert.match(tools[0].name, /nightly/)
})

test('flows that are not exposed are absent from the list', () => {
  assert.deepEqual(mcpToolsFor([{ ...base, metadata: {} }]), [])
})

test('a tool name is safe for a client to use as an identifier', () => {
  const tools = mcpToolsFor([{ ...base, name: 'Weird/Name: With Spaces!' }])
  assert.match(tools[0].name, /^[a-zA-Z0-9_-]+$/)
})

// Two flows sharing a name would otherwise produce two tools a client cannot
// tell apart — and the second would shadow the first.
test('flows with the same name get distinct tool names', () => {
  const tools = mcpToolsFor([base, { ...base, id: 'f2' }])
  assert.equal(tools.length, 2)
  assert.notEqual(tools[0].name, tools[1].name)
})

test('the description travels so a model knows what the tool does', () => {
  assert.equal(mcpToolsFor([base])[0].description, 'Syncs things')
})

// A model picking tools needs SOMETHING to go on; an empty description makes
// the tool unusable in practice.
test('a flow with no description still gets a usable one', () => {
  const tools = mcpToolsFor([{ ...base, description: '' }])
  assert.ok(tools[0].description.length > 0)
  assert.match(tools[0].description, /Nightly Sync/)
})

test('the input schema is a JSON Schema object', () => {
  const schema = mcpToolsFor([base])[0].inputSchema
  assert.equal(schema.type, 'object')
  assert.ok(schema.properties !== undefined)
})

// The declared inputs of the PUBLISHED graph, since that is what will run.
test('declared flow inputs become schema properties', () => {
  const tools = mcpToolsFor([{
    ...base,
    publishedGraph: {
      nodes: [{ id: 'in', type: 'input', data: { params: [{ name: 'account', type: 'string', required: true }] } }],
      edges: [],
    },
  }])
  const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] }
  assert.ok(schema.properties.account, 'the declared input was not in the schema')
  assert.deepEqual(schema.required, ['account'])
})
