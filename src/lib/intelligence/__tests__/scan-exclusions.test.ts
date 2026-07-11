import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionSourceRef, isValidScanExclusionEntry, isScanExcluded, toggleScanExclusion } from '../scan-exclusions'

test('connectionSourceRef: joins plane + connectionRef with a colon', () => {
  assert.equal(connectionSourceRef('mcp', 'conn123'), 'mcp:conn123')
  assert.equal(connectionSourceRef('klavis', 'agent456'), 'klavis:agent456')
  assert.equal(connectionSourceRef('nango', 'slack'), 'nango:slack')
})

test('isValidScanExclusionEntry: accepts <plane>:<nonEmptyRef> for a known plane', () => {
  assert.equal(isValidScanExclusionEntry('mcp:conn123'), true)
  assert.equal(isValidScanExclusionEntry('klavis:agent456'), true)
  assert.equal(isValidScanExclusionEntry('nango:slack'), true)
})

test('isValidScanExclusionEntry: rejects unknown planes, missing ref, and malformed strings', () => {
  assert.equal(isValidScanExclusionEntry('unknownplane:foo'), false)
  assert.equal(isValidScanExclusionEntry('mcp:'), false)
  assert.equal(isValidScanExclusionEntry('mcp'), false)
  assert.equal(isValidScanExclusionEntry(''), false)
  assert.equal(isValidScanExclusionEntry(':conn123'), false)
})

test('isScanExcluded: false for undefined/null/non-object settings', () => {
  assert.equal(isScanExcluded(undefined, 'mcp:conn123'), false)
  assert.equal(isScanExcluded(null, 'mcp:conn123'), false)
  assert.equal(isScanExcluded('not-an-object', 'mcp:conn123'), false)
  assert.equal(isScanExcluded([1, 2, 3], 'mcp:conn123'), false)
})

test('isScanExcluded: false when scanExclusions is absent or not an array', () => {
  assert.equal(isScanExcluded({}, 'mcp:conn123'), false)
  assert.equal(isScanExcluded({ scanExclusions: 'mcp:conn123' }, 'mcp:conn123'), false)
})

test('isScanExcluded: true only when the exact sourceRef is listed', () => {
  const settings = { scanExclusions: ['mcp:conn123', 'klavis:agent456'] }
  assert.equal(isScanExcluded(settings, 'mcp:conn123'), true)
  assert.equal(isScanExcluded(settings, 'klavis:agent456'), true)
  assert.equal(isScanExcluded(settings, 'mcp:other'), false)
  assert.equal(isScanExcluded({ scanExclusions: [] }, 'mcp:conn123'), false)
})

test('toggleScanExclusion: enabling learning removes the entry', () => {
  assert.deepEqual(toggleScanExclusion(['mcp:conn123', 'klavis:agent456'], 'mcp:conn123', true), ['klavis:agent456'])
})

test('toggleScanExclusion: enabling learning is a no-op when the entry is absent', () => {
  assert.deepEqual(toggleScanExclusion(['klavis:agent456'], 'mcp:conn123', true), ['klavis:agent456'])
})

test('toggleScanExclusion: disabling learning adds the entry', () => {
  assert.deepEqual(toggleScanExclusion(['klavis:agent456'], 'mcp:conn123', false), ['klavis:agent456', 'mcp:conn123'])
})

test('toggleScanExclusion: disabling learning is idempotent (no duplicate entries)', () => {
  assert.deepEqual(toggleScanExclusion(['mcp:conn123'], 'mcp:conn123', false), ['mcp:conn123'])
})

test('toggleScanExclusion: never mutates the input array', () => {
  const current = ['mcp:conn123']
  toggleScanExclusion(current, 'klavis:agent456', false)
  assert.deepEqual(current, ['mcp:conn123'])
})
