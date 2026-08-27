import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTool, grantFor, parseGrants, provisionedGrants, toolAllowed } from '../grants'

test('a legacy (null) grant is unrestricted — shipping grants changed nothing for existing agents', () => {
  assert.equal(grantFor(null, 'nango:slack'), 'write')
  assert.equal(grantFor(null, 'anything'), 'write')
})

test('lookup is most-specific first: exact id, stripped transport, plane family, alias, wildcard', () => {
  const grants = { 'postgres:write': 'blocked', postgres: 'read', slack: 'write', gmail: 'write', '*': 'read' } as const
  assert.equal(grantFor(grants, 'postgres:write'), 'blocked')
  assert.equal(grantFor(grants, 'postgres'), 'read')
  assert.equal(grantFor(grants, 'nango:slack'), 'write', 'nango: prefix is stripped')
  assert.equal(grantFor(grants, 'email'), 'write', 'email is an alias of gmail')
  assert.equal(grantFor(grants, 'qatools'), 'read', 'wildcard covers unlisted planes')
})

test('an explicit grant with no wildcard leaves unlisted planes read-only, not open', () => {
  assert.equal(grantFor({ slack: 'write' }, 'nango:salesforce'), 'read')
})

test('parseGrants keeps null as null and fails closed on junk', () => {
  assert.equal(parseGrants(null), null)
  assert.equal(parseGrants(undefined), null)
  assert.deepEqual(parseGrants('nope'), { '*': 'read' })
  assert.deepEqual(parseGrants(['read']), { '*': 'read' })
  assert.deepEqual(parseGrants({ Slack: 'write', bad: 'admin', '': 'read' }), { slack: 'write' })
})

test('MCP annotations are authoritative when present', () => {
  assert.equal(classifyTool({ name: 'delete_everything', annotations: { readOnlyHint: true } }), 'read')
  assert.equal(classifyTool({ name: 'get_thing', annotations: { destructiveHint: true } }), 'write')
})

test('a registry read-only plane classifies as read whatever the tool is called', () => {
  assert.equal(classifyTool({ name: 'notes', planeIsReadOnly: true }), 'read')
})

test('without annotations the name decides, and a write verb beats a read verb', () => {
  assert.equal(classifyTool({ name: 'slack_list_channels' }), 'read')
  assert.equal(classifyTool({ name: 'search_records' }), 'read')
  assert.equal(classifyTool({ name: 'send_message' }), 'write')
  assert.equal(classifyTool({ name: 'get_or_create_channel' }), 'write', 'creates, despite "get"')
  assert.equal(classifyTool({ name: 'log_work' }), 'write')
})

test('a tool nobody can classify is a write — the fail-closed default', () => {
  assert.equal(classifyTool({ name: 'frobnicate' }), 'write')
  assert.equal(classifyTool({ name: 'channels' }), 'write')
})

test('toolAllowed matrix', () => {
  assert.equal(toolAllowed('blocked', 'read'), false)
  assert.equal(toolAllowed('blocked', 'write'), false)
  assert.equal(toolAllowed('read', 'read'), true)
  assert.equal(toolAllowed('read', 'write'), false)
  assert.equal(toolAllowed('write', 'read'), true)
  assert.equal(toolAllowed('write', 'write'), true)
})

test("Sublime's own ledgers are never gated — a read-only agent can still log its work to a goal", () => {
  // The grant bounds what an agent does to the OUTSIDE world. Withholding
  // log_work would only blind the measurement spine.
  assert.equal(grantFor({ '*': 'read' }, 'sublime-goals'), 'write')
  assert.equal(grantFor({ '*': 'blocked', 'sublime-goals': 'blocked' }, 'sublime-goals'), 'write')
})

test('a provisioned agent writes only to the planes its spec declared', () => {
  const grants = provisionedGrants(['Slack', 'salesforce', ' '])
  assert.deepEqual(grants, { '*': 'read', slack: 'write', salesforce: 'write' })
  assert.equal(grantFor(grants, 'nango:hubspot'), 'read')
})
