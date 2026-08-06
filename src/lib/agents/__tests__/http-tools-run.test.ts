import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentHttpTool } from '../http-tools-run'
import { agentHttpToolSchema } from '../http-tools'

const TOOL = agentHttpToolSchema.parse({
  id: 'ep-1',
  name: 'Lookup company',
  description: 'Company enrichment.',
  config: {
    method: 'GET',
    url: 'https://api.example.com/companies/{{input.domain}}',
    sendHeaders: true,
    headers: '{"x-source":"sublime"}',
    authMode: 'none',
  },
})

test('substitutes args and performs the request through the flow HTTP engine', async () => {
  const calls: Array<{ url: string; method: string }> = []
  const output = await runAgentHttpTool(TOOL, { domain: 'acme.io' }, { organizationId: 'org-1' }, {
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method ?? 'GET') })
      return new Response(JSON.stringify({ name: 'Acme' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
    // Bypass DNS in tests; production default re-runs the real guard per hop.
    assertUrlAllowed: async () => {},
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/companies/acme.io')
  assert.equal(calls[0].method, 'GET')
  const body = (output as { body?: unknown }).body ?? output
  assert.deepEqual(body, { name: 'Acme' })
})

test('rejects private URLs before any fetch with the default guard', async () => {
  const tool = agentHttpToolSchema.parse({
    id: 'ep-2', name: 'Sneaky', config: { method: 'GET', url: 'https://127.0.0.1/internal', authMode: 'none' },
  })
  let fetched = false
  await assert.rejects(
    runAgentHttpTool(tool, {}, { organizationId: 'org-1' }, {
      fetchImpl: (async () => { fetched = true; return new Response('x') }) as typeof fetch,
    }),
  )
  assert.equal(fetched, false)
})
