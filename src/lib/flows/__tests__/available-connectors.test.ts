import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAvailableKlavisConnectors } from '../tool-catalog'
import { PROVIDER_CAPABILITIES } from '@/lib/mcp/provider-capabilities'
import { fromKlavisAgentType } from '@/lib/connectors/registry'

const slackName = PROVIDER_CAPABILITIES.slack.klavisName // 'Slack'
const gmailName = PROVIDER_CAPABILITIES.gmail.klavisName // 'Gmail'

test('available: includes not-connected providers with live tools + connect descriptor', () => {
  const catalog = [{ name: slackName, tools: [{ name: 'a', description: 'Do A' }, { name: 'b' }] }]
  const result = buildAvailableKlavisConnectors(catalog, new Set())
  const slack = result.find((c) => c.connect?.provider === 'slack')
  assert.ok(slack, 'slack should be available')
  assert.equal(slack!.connected, false)
  assert.deepEqual(slack!.connect, { plane: 'klavis', provider: 'slack' })
  assert.equal(slack!.name, fromKlavisAgentType('slack').label)
  // Live tool detail is preserved (names, descriptions), not just a count.
  assert.deepEqual(slack!.tools.map((t) => t.name), ['a', 'b'])
  assert.equal(slack!.tools[0].description, 'Do A')
})

test('available: excludes already-connected providers', () => {
  const catalog = [{ name: slackName, tools: [{ name: 'a' }] }]
  const result = buildAvailableKlavisConnectors(catalog, new Set(['slack']))
  assert.equal(result.find((c) => c.connect?.provider === 'slack'), undefined)
})

test('available: excludes providers not enabled on the Klavis account', () => {
  // Catalog offers only Slack — gmail must not appear even though it's a known provider.
  const catalog = [{ name: slackName, tools: [{ name: 'a' }] }]
  const result = buildAvailableKlavisConnectors(catalog, new Set())
  assert.equal(result.find((c) => c.connect?.provider === 'gmail'), undefined)
})

test('available: falls back to curated tools when the catalog entry has none', () => {
  const catalog = [{ name: gmailName }] // no tools[] in the catalog entry
  const result = buildAvailableKlavisConnectors(catalog, new Set())
  const gmail = result.find((c) => c.connect?.provider === 'gmail')
  assert.ok(gmail)
  assert.equal(gmail!.tools.length, PROVIDER_CAPABILITIES.gmail.tools.length)
  assert.deepEqual(
    gmail!.tools.map((t) => t.name),
    PROVIDER_CAPABILITIES.gmail.tools.map((t) => t.name),
  )
})

test('available: takeTools caps the tool list', () => {
  const catalog = [{ name: slackName, tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }]
  const result = buildAvailableKlavisConnectors(catalog, new Set(), 2)
  const slack = result.find((c) => c.connect?.provider === 'slack')
  assert.equal(slack!.tools.length, 2)
})

test('available: empty catalog yields nothing', () => {
  assert.deepEqual(buildAvailableKlavisConnectors([], new Set()), [])
})
