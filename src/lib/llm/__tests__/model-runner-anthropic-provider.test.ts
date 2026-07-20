/**
 * Drives AnthropicProvider against a local server speaking the real Anthropic
 * Messages SSE wire (no mocked SDK internals) — the same trick used by
 * tool-capture-e2e.test.ts. Both the "claude" and "qwen" endpoint targets are
 * pointed at this one server (via ANTHROPIC_BASE_URL / QWEN_BASE_URL), so a
 * single fixture server can drive either code path depending on which model
 * string is requested.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createModelRunner } from '../model-runner'

/** Anthropic Messages SSE for one assistant message with a given stop_reason. */
function sseFor(blocks: Array<Record<string, unknown>>, stopReason: string): string {
  const events: Array<[string, Record<string, unknown>]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
      },
    ],
  ]
  blocks.forEach((block, i) => {
    if (block.type === 'tool_use') {
      events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }])
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } }])
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index: i }])
  })
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

let server: http.Server
let nextStopReason = 'end_turn'
let nextBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: 'hello' }]
let lastRequestBody: Record<string, unknown> | null = null

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      lastRequestBody = JSON.parse(raw || '{}')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sseFor(nextBlocks, nextStopReason))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}`
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.ANTHROPIC_BASE_URL = baseUrl
  process.env.QWEN_API_KEY = 'test-key'
  process.env.QWEN_BASE_URL = baseUrl
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  nextStopReason = 'end_turn'
  nextBlocks = [{ type: 'text', text: 'hello' }]
  lastRequestBody = null
})

test('propagates stop_reason "refusal" onto the ModelTurn', async () => {
  nextStopReason = 'refusal'
  nextBlocks = []
  const runner = createModelRunner('qwen-3.7')
  const turn = await runner.next(runner.start('hi'), 'system', [])
  assert.equal(turn.stopReason, 'refusal')
})

test('propagates stop_reason "max_tokens" onto the ModelTurn', async () => {
  nextStopReason = 'max_tokens'
  nextBlocks = [{ type: 'text', text: 'partial...' }]
  const runner = createModelRunner('qwen-3.7')
  const turn = await runner.next(runner.start('hi'), 'system', [])
  assert.equal(turn.stopReason, 'max_tokens')
})

test('propagates stop_reason "end_turn" for a normal completion', async () => {
  nextStopReason = 'end_turn'
  nextBlocks = [{ type: 'text', text: 'all done' }]
  const runner = createModelRunner('qwen-3.7')
  const turn = await runner.next(runner.start('hi'), 'system', [])
  assert.equal(turn.stopReason, 'end_turn')
  assert.equal(turn.text, 'all done')
})

test('does not send output_config.effort for a model outside the adaptive-thinking family (e.g. Qwen)', async () => {
  const runner = createModelRunner('qwen-3.7')
  await runner.next(runner.start('hi'), 'system', [], 'high')
  assert.equal(lastRequestBody?.output_config, undefined)
})

test('sends the requested output_config.effort for a model in the adaptive-thinking family', async () => {
  const runner = createModelRunner('claude-sonnet-5')
  await runner.next(runner.start('hi'), 'system', [], 'medium')
  assert.deepEqual((lastRequestBody?.output_config as Record<string, unknown> | undefined)?.effort, 'medium')
})
