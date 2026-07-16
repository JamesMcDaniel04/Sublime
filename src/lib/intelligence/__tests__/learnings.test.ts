import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSourceRef, planeLabel } from '../learnings'

test('parseSourceRef: splits "<plane>:<ref>" into parts', () => {
  assert.deepEqual(parseSourceRef('mcp:conn123'), { plane: 'mcp', ref: 'conn123' })
  assert.deepEqual(parseSourceRef('nango:slack'), { plane: 'nango', ref: 'slack' })
})

test('parseSourceRef: tolerates a ref that itself contains colons', () => {
  assert.deepEqual(parseSourceRef('mcp:foo:bar'), { plane: 'mcp', ref: 'foo:bar' })
})

test('parseSourceRef: null for null/undefined/empty input', () => {
  assert.equal(parseSourceRef(null), null)
  assert.equal(parseSourceRef(undefined), null)
  assert.equal(parseSourceRef(''), null)
})

test('parseSourceRef: null for malformed input (no colon, or an empty side)', () => {
  assert.equal(parseSourceRef('noColonHere'), null)
  assert.equal(parseSourceRef(':missingPlane'), null)
  assert.equal(parseSourceRef('missingRef:'), null)
})

test('planeLabel: known planes get a friendly fallback label', () => {
  assert.equal(planeLabel('mcp'), 'MCP server')
  assert.equal(planeLabel('nango'), 'Connected account')
})

test('planeLabel: unknown plane falls back to "Connection"', () => {
  assert.equal(planeLabel('something-else'), 'Connection')
})
