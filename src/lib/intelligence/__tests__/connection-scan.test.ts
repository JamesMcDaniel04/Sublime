import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectScanTools, scanEnabled, MAX_SCAN_TOOLS } from '../connection-scan'

test('selectScanTools: empty input returns []', () => {
  assert.deepEqual(selectScanTools([]), [])
})

test('selectScanTools: keeps read-allowlisted tools', () => {
  const tools = [
    { name: 'list_channels', description: 'List all channels' },
    { name: 'get_user', description: 'Fetch a user by id' },
  ]
  assert.deepEqual(selectScanTools(tools), ['list_channels', 'get_user'])
})

test('selectScanTools: excludes tools that are not on the read allowlist', () => {
  const tools = [
    { name: 'ping', description: 'Health check' },
    { name: 'get_user', description: 'Fetch a user by id' },
  ]
  assert.deepEqual(selectScanTools(tools), ['get_user'])
})

test('selectScanTools: write-verb names excluded even when they also match the allowlist', () => {
  const tools = [
    // Matches the read allowlist ("list") AND a write verb ("archive") —
    // the write verb must win.
    { name: 'archive_and_list_messages', description: 'Archives then lists messages' },
    { name: 'list_messages', description: 'List messages' },
  ]
  assert.deepEqual(selectScanTools(tools), ['list_messages'])
})

test('selectScanTools: excludes write verbs found only in the description', () => {
  const tools = [
    { name: 'search_records', description: 'Searches then permanently deletes stale records' },
    { name: 'search_users', description: 'Searches for users' },
  ]
  assert.deepEqual(selectScanTools(tools), ['search_users'])
})

test('selectScanTools: caps at the default max (6)', () => {
  const tools = Array.from({ length: 10 }, (_, i) => ({ name: `list_thing_${i}`, description: 'lists things' }))
  const result = selectScanTools(tools)
  assert.equal(result.length, MAX_SCAN_TOOLS)
  assert.deepEqual(result, tools.slice(0, MAX_SCAN_TOOLS).map((t) => t.name))
})

test('selectScanTools: respects a custom max', () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `get_thing_${i}`, description: 'gets things' }))
  assert.equal(selectScanTools(tools, 2).length, 2)
})

test('scanEnabled: defaults to true for undefined/null settings', () => {
  assert.equal(scanEnabled(undefined), true)
  assert.equal(scanEnabled(null), true)
})

test('scanEnabled: defaults to true when the flag is absent', () => {
  assert.equal(scanEnabled({}), true)
  assert.equal(scanEnabled({ someOtherFlag: true }), true)
})

test('scanEnabled: false when disableConnectionScans is true', () => {
  assert.equal(scanEnabled({ disableConnectionScans: true }), false)
})

test('scanEnabled: true when disableConnectionScans is falsy but present', () => {
  assert.equal(scanEnabled({ disableConnectionScans: false }), true)
})

test('scanEnabled: non-object settings fall back to true', () => {
  assert.equal(scanEnabled('not-an-object'), true)
  assert.equal(scanEnabled(42), true)
  assert.equal(scanEnabled([1, 2, 3]), true)
})
