import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolRegistry } from '../tool-registry'

test('merges groups and tags provenance', () => {
  const { tools } = buildToolRegistry([
    [{ name: 'find_account', provenance: 'people_ai', description: 'read' }],
    [{ name: 'slack_post_message', provenance: 'nango', description: 'send' }],
  ])
  assert.equal(tools.length, 2)
  assert.equal(tools.find((t) => t.name === 'find_account')!.provenance, 'people_ai')
  assert.equal(tools.find((t) => t.name === 'slack_post_message')!.provenance, 'nango')
})

test('first group wins on a name collision; the loser is reported', () => {
  const { tools, dropped } = buildToolRegistry([
    [{ name: 'send', provenance: 'nango' }],
    [{ name: 'send', provenance: 'klavis' }],
  ])
  assert.equal(tools.length, 1)
  assert.equal(tools[0].provenance, 'nango')
  assert.deepEqual(dropped, [{ name: 'send', provenance: 'klavis', keptProvenance: 'nango' }])
})

test('normalizes missing/invalid schema and description', () => {
  const { tools } = buildToolRegistry([[{ name: 't', provenance: 'native', inputSchema: null }]])
  assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {} })
  assert.equal(tools[0].description, 't')
})

test('empty input yields an empty registry', () => {
  const { tools, dropped } = buildToolRegistry([])
  assert.deepEqual(tools, [])
  assert.deepEqual(dropped, [])
})
