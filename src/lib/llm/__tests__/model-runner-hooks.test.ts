import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let server: http.Server

function sseTextMessage(chunks: string[]): string {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'qwen-test', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...chunks.map((chunk): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      void raw
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sseTextMessage(['Hel', 'lo ', 'world']))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  process.env.QWEN_API_KEY = 'test-key'
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${port}`
  process.env.QWEN_MODEL = 'qwen-test'
  delete process.env.ANTHROPIC_API_KEY
})

after(async () => {
  delete process.env.QWEN_API_KEY
  delete process.env.QWEN_BASE_URL
  delete process.env.QWEN_MODEL
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('onTextDelta receives streamed text before the turn resolves', async () => {
  const { createModelRunner } = await import('@/lib/llm/model-runner')
  const runner = createModelRunner('qwen-3.7')
  const deltas: string[] = []
  const transcript = runner.start('hi')
  const turn = await runner.next(transcript, 'You are a test.', [], undefined, {
    onTextDelta: (delta) => deltas.push(delta),
  })
  assert.deepEqual(deltas, ['Hel', 'lo ', 'world'])
  assert.equal(turn.text, 'Hello world')
  assert.equal(turn.usage.outputTokens, 7)
})

test('next() without hooks still works (backward compatibility)', async () => {
  const { createModelRunner } = await import('@/lib/llm/model-runner')
  const runner = createModelRunner('qwen-3.7')
  const transcript = runner.start('hi')
  const turn = await runner.next(transcript, 'You are a test.', [])
  assert.equal(turn.text, 'Hello world')
})
