import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamableHttpMcpClient, parseRpc } from '../streamable-http'

const SERVER = 'https://mcp.example.com/mcp'

type Call = { method: string; headers: Record<string, string>; body: any }

function mockServer(handler: (call: Call, index: number) => Response) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    const body = JSON.parse(String(init?.body))
    const call = { method: body.method, headers, body }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return { calls, fetchImpl }
}

function rpcOk(result: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

test('parseRpc handles plain JSON and SSE frames', () => {
  assert.deepEqual(parseRpc('{"result":{"a":1}}').result, { a: 1 })
  const sse = 'event: message\ndata: {"result":{"tools":[]}}\n\ndata: [DONE]\n'
  assert.deepEqual(parseRpc(sse).result, { tools: [] })
})

test('initialize handshake runs once, session id is reused, tools listed', async () => {
  const { calls, fetchImpl } = mockServer((call) => {
    if (call.method === 'initialize') return rpcOk({}, { 'Mcp-Session-Id': 'sess-1' })
    if (call.method === 'notifications/initialized') return rpcOk(null)
    if (call.method === 'tools/list') return rpcOk({ tools: [{ name: 'find_account', description: 'd', inputSchema: { type: 'object' } }] })
    throw new Error(`unexpected ${call.method}`)
  })
  const client = new StreamableHttpMcpClient({ getHeaders: async () => ({ Authorization: 'Bearer t' }), fetchImpl })
  const tools = await client.getServerTools(SERVER)
  assert.deepEqual(tools, [{ name: 'find_account', description: 'd', inputSchema: { type: 'object' } }])
  // list again — initialize must not repeat
  await client.getServerTools(SERVER)
  const initCount = calls.filter((c) => c.method === 'initialize').length
  assert.equal(initCount, 1)
  const lastList = calls.filter((c) => c.method === 'tools/list').at(-1)!
  assert.equal(lastList.headers['Mcp-Session-Id'], 'sess-1')
})

test('callTool returns result and surfaces JSON-RPC errors', async () => {
  const { fetchImpl } = mockServer((call) => {
    if (call.method === 'initialize') return rpcOk({})
    if (call.method === 'notifications/initialized') return rpcOk(null)
    if (call.method === 'tools/call' && call.body.params.name === 'ok') return rpcOk({ content: [{ type: 'text', text: 'hi' }] })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { message: 'tool exploded' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const client = new StreamableHttpMcpClient({ getHeaders: async () => ({}), fetchImpl })
  const result = (await client.callTool(SERVER, 'ok', { q: 1 })) as any
  assert.equal(result.content[0].text, 'hi')
  await assert.rejects(client.callTool(SERVER, 'bad', {}), /tool exploded/)
})

test('401 triggers onUnauthorized once and retries with fresh headers', async () => {
  let token = 'stale'
  let unauthorizedCalls = 0
  const { calls, fetchImpl } = mockServer((call) => {
    if (call.headers.Authorization === 'Bearer stale') return new Response('', { status: 401 })
    if (call.method === 'initialize') return rpcOk({})
    if (call.method === 'notifications/initialized') return rpcOk(null)
    if (call.method === 'tools/list') return rpcOk({ tools: [] })
    throw new Error(`unexpected ${call.method}`)
  })
  const client = new StreamableHttpMcpClient({
    getHeaders: async () => ({ Authorization: `Bearer ${token}` }),
    onUnauthorized: async () => {
      unauthorizedCalls++
      token = 'fresh'
      return true
    },
    fetchImpl,
  })
  const tools = await client.getServerTools(SERVER)
  assert.deepEqual(tools, [])
  assert.equal(unauthorizedCalls, 1)
  assert.ok(calls.some((c) => c.headers.Authorization === 'Bearer fresh'))
})

test('401 with failed recovery propagates the error', async () => {
  const { fetchImpl } = mockServer(() => new Response('', { status: 401 }))
  const client = new StreamableHttpMcpClient({
    getHeaders: async () => ({ Authorization: 'Bearer dead' }),
    onUnauthorized: async () => false,
    fetchImpl,
  })
  await assert.rejects(client.getServerTools(SERVER), /401/)
})
