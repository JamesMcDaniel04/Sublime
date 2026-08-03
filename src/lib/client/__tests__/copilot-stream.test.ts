import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { streamCopilot } from '../copilot-stream'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function sseFetch(chunks: string[], init?: { status?: number; contentType?: string }) {
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, {
      status: init?.status ?? 200,
      headers: { 'Content-Type': init?.contentType ?? 'text/event-stream' },
    })
  }) as typeof fetch
}

test('parses text, tool, and result events across chunk boundaries', async () => {
  // Deliberately split one event across two network chunks.
  sseFetch([
    'data: {"type":"text","delta":"Hel"}\n\ndata: {"type":"te',
    'xt","delta":"lo"}\n\ndata: {"type":"tool","name":"get_run","label":"Reading run r1"}\n\n',
    'data: {"type":"result","reply":"done"}\n\n',
  ])
  const texts: string[] = []
  const tools: string[] = []
  const outcome = await streamCopilot('/api/x', {}, {
    onText: (delta) => texts.push(delta),
    onTool: (activity) => tools.push(activity.label),
  })
  assert.deepEqual(texts, ['Hel', 'lo'])
  assert.deepEqual(tools, ['Reading run r1'])
  assert.deepEqual(outcome, { ok: true, result: { type: 'result', reply: 'done' } })
})

test('an error event resolves as failure', async () => {
  sseFetch(['data: {"type":"error","message":"budget","code":"BUDGET_EXCEEDED"}\n\n'])
  const outcome = await streamCopilot('/api/x', {}, {})
  assert.deepEqual(outcome, { ok: false, error: 'budget', code: 'BUDGET_EXCEEDED' })
})

test('a JSON (non-stream) error response resolves as failure with status', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'Monthly token budget reached' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  const outcome = await streamCopilot('/api/x', {}, {})
  assert.equal(outcome.ok, false)
  if (!outcome.ok) { assert.equal(outcome.status, 429); assert.match(outcome.error, /budget/) }
})

test('a stream that ends without a result event is a connection loss', async () => {
  sseFetch(['data: {"type":"text","delta":"partial"}\n\n'])
  const outcome = await streamCopilot('/api/x', {}, {})
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.error, /Connection lost/)
})
