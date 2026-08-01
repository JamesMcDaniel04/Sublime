import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeToolResult, TOOL_RESULT_MAX_CHARS } from '../tool-result'

test('small results pass through as plain JSON', () => {
  assert.equal(serializeToolResult({ ok: true, n: 1 }), JSON.stringify({ ok: true, n: 1 }))
  assert.equal(serializeToolResult(null), 'null')
  assert.equal(serializeToolResult(undefined), 'null')
})

test('oversized results are capped into a valid-JSON truncation wrapper', () => {
  const big = { rows: 'x'.repeat(200_000) }
  const out = serializeToolResult(big, 50_000)

  assert.ok(out.length < 51_000, `stays near the cap (got ${out.length})`)
  const parsed = JSON.parse(out) as { truncated: boolean; totalChars: number; content: string }
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.totalChars, JSON.stringify(big).length)
  assert.ok(parsed.content.length <= 50_000)
})

test('default cap is 50k chars', () => {
  assert.equal(TOOL_RESULT_MAX_CHARS, 50_000)
  const out = serializeToolResult('y'.repeat(80_000))
  assert.equal((JSON.parse(out) as { truncated: boolean }).truncated, true)
})

test('serializeToolResult redacts credential-shaped strings before the transcript', () => {
  const out = serializeToolResult({
    ok: true,
    token: 'xoxb-1234567890-abcdefghij',
    headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' },
  })
  assert.ok(!out.includes('xoxb-1234567890-abcdefghij'))
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz0123456789'))
  assert.ok(out.includes('[redacted:'))
  assert.doesNotThrow(() => JSON.parse(out))
})
