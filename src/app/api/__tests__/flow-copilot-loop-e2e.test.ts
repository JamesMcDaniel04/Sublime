import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { startFakeLlm } from './fake-llm-sse'

let prisma: typeof import('@/lib/prisma').prisma
let seeded: Awaited<ReturnType<Awaited<typeof import('@/lib/server/__tests__/test-auth')>['seedTestOrg']>>
let fake: Awaited<ReturnType<typeof startFakeLlm>>

const GRAPH = {
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Manual', trigger: { type: 'manual' } } },
    { id: 'step1', type: 'agent', position: { x: 0, y: 120 }, data: { label: 'Draft', prompt: 'draft an email' } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'step1' }],
}

before(async () => {
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  installTestAuth(seeded.auth)

  fake = await startFakeLlm([
    {
      text: 'Renaming the step.',
      toolUse: {
        id: 'tu1', name: 'edit_flow',
        input: { message: 'Renamed the draft step.', opsJson: JSON.stringify([{ op: 'update', id: 'step1', data: { label: 'Draft email' } }]) },
      },
    },
  ])
  process.env.QWEN_API_KEY = 'fake'
  process.env.QWEN_BASE_URL = fake.url
  process.env.AGENT_MODEL = 'qwen-3.7'
  delete process.env.ANTHROPIC_API_KEY
})

after(async () => {
  delete process.env.QWEN_API_KEY
  delete process.env.QWEN_BASE_URL
  delete process.env.AGENT_MODEL
  await fake.close()
  await seeded.cleanup()
})

function parseSse(bodyText: string): Array<Record<string, unknown>> {
  return bodyText.split('\n\n').filter(Boolean)
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
}

test('streaming POST ends in a result event carrying sanitized ops', async () => {
  const { POST } = await import('../flows/copilot/chat/route')
  const request = new NextRequest(new URL('http://test/api/flows/copilot/chat'), {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'rename step1 to Draft email' }], graph: GRAPH }),
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  } as never)
  const response = await POST(request)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const events = parseSse(await new Response(response.body).text())
  const result = events[events.length - 1] as unknown as { type: string; success: boolean; message: string; ops: Array<{ op: string }> }
  assert.equal(result.type, 'result')
  assert.equal(result.success, true)
  assert.equal(result.ops.length, 1)
  assert.equal(result.ops[0].op, 'update')
})

test('JSON fallback matches the legacy contract', async () => {
  const { POST } = await import('../flows/copilot/chat/route')
  const request = new NextRequest(new URL('http://test/api/flows/copilot/chat'), {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'rename step1' }], graph: GRAPH }),
    headers: { 'content-type': 'application/json' },
  } as never)
  const response = await POST(request)
  const body = (await response.json()) as { success: boolean; message: string; ops: unknown[]; needsAttention: unknown[] }
  assert.equal(body.success, true)
  assert.ok(Array.isArray(body.ops))
  assert.ok(Array.isArray(body.needsAttention))
})
