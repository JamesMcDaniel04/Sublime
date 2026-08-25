/**
 * Serving MCP: the JSON-RPC layer that lets an external client (Claude
 * Desktop, Cursor, another agent platform) call this workspace's flows as
 * tools.
 *
 * The inverse of mcp-client.ts, which consumes other people's servers. Kept
 * pure and separate from the route so every protocol rule can be tested
 * without a network or a database — a malformed request from a client we do
 * not control must produce a well-formed error, never a crash.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleMcpRequest,
  MCP_PROTOCOL_VERSION,
  type McpTool,
  type McpServerContext,
} from '../server-protocol'

const tools: McpTool[] = [
  {
    name: 'nightly_sync',
    description: 'Syncs things',
    inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
    flowId: 'flow-1',
  },
]

const noop: McpServerContext['invoke'] = async () => ({ ok: true, output: 'done' })

/**
 * A JSON-RPC result is a different shape per method, so the envelope types it
 * as a permissive record. Tests legitimately read the fields for the method
 * they just called, so they narrow here rather than the production type being
 * loosened for their convenience.
 */
type ProbedResponse = {
  jsonrpc?: string
  id?: string | number | null
  result?: any
  error?: { code: number; message: string }
} | null

const call = async (body: unknown, invoke: McpServerContext['invoke'] = noop): Promise<ProbedResponse> =>
  handleMcpRequest(body, { tools, invoke }) as Promise<ProbedResponse>

// ── initialize ──────────────────────────────────────────────────────────────

test('initialize reports the protocol version and tool capability', async () => {
  const response = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } })
  assert.equal(response?.id, 1)
  assert.equal(response?.result?.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.ok(response?.result?.capabilities?.tools, 'the server must advertise tools')
  assert.ok(response?.result?.serverInfo?.name)
})

// A client asking for a version we do not speak still gets ours, rather than a
// failed handshake it cannot interpret.
test('an unknown protocol version still completes the handshake', async () => {
  const response = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal(response?.result?.protocolVersion, MCP_PROTOCOL_VERSION)
})

// ── notifications ───────────────────────────────────────────────────────────

// A notification has no id and MUST NOT be answered — a response to one is a
// protocol violation that some clients treat as fatal.
test('a notification produces no response at all', async () => {
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
})

// ── tools/list ──────────────────────────────────────────────────────────────

test('tools/list returns the exposed flows', async () => {
  const response = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal(response?.result?.tools?.length, 1)
  assert.equal(response?.result?.tools?.[0].name, 'nightly_sync')
  assert.deepEqual(response?.result?.tools?.[0].inputSchema.required, ['account'])
})

// The flow id is ours, not the client's business — and leaking internal ids
// invites a client to try addressing flows by id instead of by tool name.
test('the internal flow id is not exposed to the client', async () => {
  const response = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.ok(!JSON.stringify(response?.result).includes('flow-1'))
})

test('a workspace exposing nothing returns an empty list, not an error', async () => {
  const response = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { tools: [], invoke: async () => ({ ok: true, output: '' }) })
  assert.deepEqual(response?.result?.tools, [])
})

// ── tools/call ──────────────────────────────────────────────────────────────

test('tools/call runs the named flow and returns its output', async () => {
  let ran = ''
  const response = await call(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nightly_sync', arguments: { account: 'acme' } } },
    async (tool) => { ran = tool.flowId; return { ok: true, output: 'synced' } },
  )
  assert.equal(ran, 'flow-1')
  assert.equal(response?.result?.content?.[0].text, 'synced')
  assert.equal(response?.result?.isError, false)
})

test('the arguments reach the flow', async () => {
  let seen: unknown
  await call(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nightly_sync', arguments: { account: 'acme' } } },
    async (_tool, args) => { seen = args; return { ok: true, output: '' } },
  )
  assert.deepEqual(seen, { account: 'acme' })
})

// An unknown tool is a TOOL error, not a protocol error: MCP distinguishes
// "your request was malformed" from "the tool you ran failed", and a client
// shows the second to its user rather than disconnecting.
test('an unknown tool is reported as a tool error, not a protocol error', async () => {
  const response = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool' } })
  assert.equal(response?.result?.isError, true)
  assert.equal(response?.error, undefined, 'an unknown tool must not fail the JSON-RPC envelope')
})

test('a failing flow is reported as a tool error with its message', async () => {
  const response = await call(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nightly_sync', arguments: {} } },
    async () => ({ ok: false, error: 'the flow failed' }),
  )
  assert.equal(response?.result?.isError, true)
  assert.match(response?.result?.content?.[0].text ?? '', /the flow failed/)
})

// A flow that throws must not take down the connection.
test('a thrown error becomes a tool error rather than escaping', async () => {
  const response = await call(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nightly_sync', arguments: {} } },
    async () => { throw new Error('boom') },
  )
  assert.equal(response?.result?.isError, true)
})

// ── malformed input ─────────────────────────────────────────────────────────
//
// Everything below arrives from a client we do not control.

test('an unknown method returns method-not-found', async () => {
  const response = await call({ jsonrpc: '2.0', id: 4, method: 'resources/list' })
  assert.equal(response?.error?.code, -32601)
})

test('a non-object body is an invalid request', async () => {
  assert.equal((await call('hello'))?.error?.code, -32600)
  assert.equal((await call(null))?.error?.code, -32600)
  assert.equal((await call([1, 2, 3]))?.error?.code, -32600)
})

test('a missing method is an invalid request', async () => {
  assert.equal((await call({ jsonrpc: '2.0', id: 5 }))?.error?.code, -32600)
})

test('tools/call with no name is invalid params', async () => {
  assert.equal((await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} }))?.error?.code, -32602)
})

test('the id is echoed back on an error so the client can match it', async () => {
  const response = await call({ jsonrpc: '2.0', id: 42, method: 'nope' })
  assert.equal(response?.id, 42)
})

test('every response carries the jsonrpc version', async () => {
  const response = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(response?.jsonrpc, '2.0')
})
