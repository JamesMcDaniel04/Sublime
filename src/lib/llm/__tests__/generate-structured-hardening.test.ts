/**
 * Hardening for the one-shot structured-completion path (generateStructured →
 * anthropicWireStructured), used by every synchronous chat/copilot API route.
 * Drives a local server speaking the real Anthropic Messages wire, same trick
 * as model-runner-anthropic-provider.test.ts.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { generateStructured } from '../model-runner'

const SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] } as const

function sseForText(text: string): string {
  const events: Array<[string, Record<string, unknown>]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

let server: http.Server
let lastRequestBody: Record<string, unknown> | null = null
let responseDelayMs = 0

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      lastRequestBody = JSON.parse(raw || '{}')
      const body = lastRequestBody
      const send = () => {
        if (body?.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(sseForText('{"reply":"ok"}'))
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg_test', type: 'message', role: 'assistant', model: 'test',
            content: [{ type: 'text', text: '{"reply":"ok"}' }],
            stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
          }))
        }
      }
      if (responseDelayMs > 0) setTimeout(send, responseDelayMs)
      else send()
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
  lastRequestBody = null
  responseDelayMs = 0
})

test('generateStructured streams the call rather than using a non-streaming request', async () => {
  await generateStructured({ system: 's', user: 'u', schema: SCHEMA, schemaName: 'test', model: 'claude-sonnet-5' })
  assert.equal(lastRequestBody?.stream, true)
})

test('generateStructured sets output_config.effort for a model in the adaptive-thinking family', async () => {
  await generateStructured({ system: 's', user: 'u', schema: SCHEMA, schemaName: 'test', model: 'claude-sonnet-5' })
  const outputConfig = lastRequestBody?.output_config as Record<string, unknown> | undefined
  assert.equal(outputConfig?.effort, 'medium')
})

test('generateStructured does not set effort for a model outside the adaptive-thinking family (Qwen)', async () => {
  await generateStructured({ system: 's', user: 'u', schema: SCHEMA, schemaName: 'test', model: 'qwen-3.7' })
  const outputConfig = lastRequestBody?.output_config as Record<string, unknown> | undefined
  assert.equal(outputConfig?.effort, undefined)
})

test(
  'generateStructured aborts a hung call at the configured deadline instead of hanging indefinitely',
  { timeout: 3000 },
  async () => {
    process.env.LLM_STRUCTURED_CALL_DEADLINE_MS = '100'
    responseDelayMs = 2000 // far past the 100ms deadline, well under the 3s test timeout
    try {
      await assert.rejects(
        generateStructured({ system: 's', user: 'u', schema: SCHEMA, schemaName: 'test', model: 'claude-sonnet-5' }),
      )
    } finally {
      delete process.env.LLM_STRUCTURED_CALL_DEADLINE_MS
    }
  },
)
