import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeUpstream } from '../context'

test('empty aggregate serializes to {}', () => {
  assert.equal(serializeUpstream({}), '{}')
})

test('serializes a label→output map as JSON', () => {
  const out = serializeUpstream({ 'Fetch CRM': { ok: true, body: { name: 'Acme' } } })
  assert.match(out, /Fetch CRM/)
  assert.match(out, /Acme/)
  assert.equal(typeof JSON.parse(out), 'object')
})

test('truncates an oversized single node output with a marker', () => {
  const big = 'x'.repeat(5_000)
  const out = serializeUpstream({ Huge: big }, 1_000)
  assert.ok(out.includes('…[truncated]'), 'marks truncation')
  assert.ok(out.length <= 1_100, `stays near the cap (was ${out.length})`)
})

test('bounds the total serialized size across many nodes', () => {
  const bundle: Record<string, unknown> = {}
  for (let i = 0; i < 50; i++) bundle[`Node ${i}`] = 'y'.repeat(2_000)
  const out = serializeUpstream(bundle, 5_000)
  assert.ok(out.length <= 5_100, `total stays near the cap (was ${out.length})`)
})
