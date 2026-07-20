import { test } from 'node:test'
import assert from 'node:assert/strict'
import { irUser, irToolResults, irFromAnthropic, toAnthropicMessages, coerceToIR, type IRMessage } from '../ir'
import { routeModel } from '../model-runner'

// A synthetic Anthropic response with a thinking block, text, and a tool call.
const anthropicMessage = {
  content: [
    { type: 'thinking', thinking: 'let me reason', signature: 'sig-abc' },
    { type: 'text', text: 'Looking up ACME.' },
    { type: 'tool_use', id: 'toolu_1', name: 'crm_get_account', input: { account: 'ACME' } },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
} as never

test('irFromAnthropic keeps neutral fields AND raw native content', () => {
  const ir = irFromAnthropic(anthropicMessage)
  assert.equal(ir.text, 'Looking up ACME.')
  assert.deepEqual(ir.toolCalls, [{ id: 'toolu_1', name: 'crm_get_account', input: { account: 'ACME' } }])
  assert.equal(ir.raw?.provider, 'anthropic')
})

test('same-provider replay is lossless — thinking blocks survive the round-trip', () => {
  const ir: IRMessage[] = [irUser('go'), irFromAnthropic(anthropicMessage)]
  const [, assistant] = toAnthropicMessages(ir)
  // Verbatim native content: the thinking block (with its signature) is intact.
  assert.deepEqual(assistant.content, (anthropicMessage as { content: unknown }).content)
})

// Exercises the live cross-provider path: an assistant message tagged with a
// raw provider OTHER than 'anthropic' (e.g. a run resumed after switching
// endpoints, or an old execution persisted under a since-removed OpenAI
// provider) must ignore `raw` and rebuild from the neutral fields — which
// correctly drops thinking, since it never survived translation to begin
// with (only the neutral text/toolCalls fields did).
test('cross-provider translation DROPS raw content, rebuilds from neutral fields', () => {
  const ir: IRMessage[] = [
    irUser('go'),
    {
      role: 'assistant',
      text: 'Looking up ACME.',
      toolCalls: [{ id: 'toolu_1', name: 'crm_get_account', input: { account: 'ACME' } }],
      raw: { provider: 'openai', content: { role: 'assistant', content: 'Looking up ACME.', tool_calls: [] } },
    },
  ]
  const [, assistant] = toAnthropicMessages(ir)
  assert.deepEqual(assistant.content, [
    { type: 'text', text: 'Looking up ACME.' },
    { type: 'tool_use', id: 'toolu_1', name: 'crm_get_account', input: { account: 'ACME' } },
  ])
})

test('tool results translate to the Anthropic tool_result shape', () => {
  const ir: IRMessage[] = [irToolResults([{ toolCallId: 'toolu_1', content: '{"ok":true}' }])]
  const [anthropic] = toAnthropicMessages(ir)
  assert.equal(anthropic.role, 'user')
  assert.deepEqual(anthropic.content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }])
})

test('coerceToIR: native Anthropic transcript → IR', () => {
  const native = [
    { role: 'user', content: 'Check ACME.' },
    { role: 'assistant', content: (anthropicMessage as { content: unknown[] }).content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"ACME"}' }] },
  ]
  const ir = coerceToIR(native)
  assert.equal(ir.length, 3)
  assert.deepEqual(ir[0], { role: 'user', content: 'Check ACME.' })
  assert.equal(ir[1].role, 'assistant')
  assert.equal((ir[1] as { raw?: { provider: string } }).raw?.provider, 'anthropic')
  assert.deepEqual(ir[2], { role: 'tool', results: [{ toolCallId: 'toolu_1', content: '{"name":"ACME"}', isError: false }] })
})

test('coerceToIR: native OpenAI transcript merges consecutive tool messages', () => {
  const native = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'b', arguments: '{"x":1}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'tool', tool_call_id: 'c2', content: 'r2' },
  ]
  const ir = coerceToIR(native)
  assert.equal(ir.length, 3) // user, assistant, ONE merged tool turn
  assert.equal(ir[1].role, 'assistant')
  assert.deepEqual((ir[1] as { toolCalls: unknown }).toolCalls, [
    { id: 'c1', name: 'a', input: {} },
    { id: 'c2', name: 'b', input: { x: 1 } },
  ])
  assert.deepEqual((ir[2] as { results: unknown }).results, [
    { toolCallId: 'c1', content: 'r1', isError: false },
    { toolCallId: 'c2', content: 'r2', isError: false },
  ])
})

test('coerceToIR is idempotent on already-IR input', () => {
  const ir: IRMessage[] = [
    irUser('go'),
    { role: 'assistant', text: 'hi', toolCalls: [], raw: { provider: 'openai', content: {} } },
    irToolResults([{ toolCallId: 'c1', content: 'r' }]),
  ]
  assert.deepEqual(coerceToIR(ir as unknown[]), ir)
})

// ── Explicit routing ─────────────────────────────────────────────────────────
test('routeModel orders the requested provider first, then the fallback', () => {
  const prevA = process.env.ANTHROPIC_API_KEY
  const prevK = process.env.QWEN_API_KEY
  const prevU = process.env.QWEN_BASE_URL
  try {
    process.env.ANTHROPIC_API_KEY = 'x'
    // Qwen (the OpenAI-compatible slot) needs both a key and a base URL.
    process.env.QWEN_API_KEY = 'y'
    process.env.QWEN_BASE_URL = 'https://qwen.example/v1'
    assert.deepEqual(routeModel('claude-opus-4-8'), [
      { target: 'claude', model: 'claude-opus-4-8' },
      { target: 'qwen', model: 'qwen-3.7' },
    ])
    assert.deepEqual(routeModel('qwen-3.7'), [
      { target: 'qwen', model: 'qwen-3.7' },
      { target: 'claude', model: 'claude-opus-4-8' },
    ])
    // Only the configured provider survives when Qwen is not configured.
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_BASE_URL
    assert.deepEqual(routeModel('qwen-3.7'), [{ target: 'claude', model: 'claude-opus-4-8' }])
  } finally {
    if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevA
    if (prevK === undefined) delete process.env.QWEN_API_KEY
    else process.env.QWEN_API_KEY = prevK
    if (prevU === undefined) delete process.env.QWEN_BASE_URL
    else process.env.QWEN_BASE_URL = prevU
  }
})
