import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_CONNECTORS,
  nangoConnector,
  isSelected,
  isWriteProvider,
  alwaysRequiresApproval,
  fromNangoProviderKey,
} from '../registry'

const slackBuiltin = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'slack')!

test('isSelected matches case-insensitively and by substring', () => {
  assert.equal(isSelected(slackBuiltin, ['Slack']), true)
  assert.equal(isSelected(slackBuiltin, ['slack']), true)
  assert.equal(isSelected(slackBuiltin, ['my-slack-workspace']), true)
  assert.equal(isSelected(slackBuiltin, ['Email', 'Granola']), false)
})

test('nangoConnector resolves a delivery capability to its provider id', () => {
  assert.equal(nangoConnector('gmail')?.providerId, 'nango:gmail')
  assert.equal(nangoConnector('salesforce')?.providerId, 'nango:salesforce')
  assert.equal(nangoConnector('unknown'), undefined)
})

test('isWriteProvider classifies delivery planes as writes and reads as reads', () => {
  assert.equal(isWriteProvider('nango:slack'), true)
  assert.equal(isWriteProvider('nango:gmail'), true)
  assert.equal(isWriteProvider('slack'), true) // built-in Slack
  assert.equal(isWriteProvider('email'), true)
  assert.equal(isWriteProvider('granola'), false)
  assert.equal(isWriteProvider('github'), false) // unknown provider reads
})

test('every write connector is either a delivery plane or unconditionally approval-gated', () => {
  // Delivery planes (Slack/Email/HTTP/nango:*) follow the agent's own
  // requireApproval opt-in, which defaults OFF — acceptable when the blast
  // radius is a message. Any OTHER kind of write plane reaches customer-owned
  // infrastructure, so it must carry its own mandatory approval instead of
  // inheriting a default-off flag.
  for (const connector of BUILTIN_CONNECTORS.filter((c) => c.isWrite)) {
    const isDelivery = connector.kind === 'builtin' || connector.kind === 'nango'
    assert.ok(
      isDelivery || connector.alwaysRequiresApproval === true,
      `${connector.providerId} writes without being a delivery plane, so it must set alwaysRequiresApproval`,
    )
  }
})

test('alwaysRequiresApproval resolves for the Postgres write plane only', () => {
  assert.equal(alwaysRequiresApproval('postgres:write'), true)
  for (const provider of ['postgres', 'slack', 'email', 'http', 'nango:gmail', 'granola', 'unknown']) {
    assert.equal(alwaysRequiresApproval(provider), false, `${provider} must not force approval`)
  }
})

test('the Postgres write plane is never user-selectable', () => {
  // It is activated per-connection by allowWrites, so no stored agent
  // selection may switch it on — including one that literally says "postgres".
  const write = BUILTIN_CONNECTORS.find((c) => c.providerId === 'postgres:write')!
  for (const selection of ['postgres', 'PostgreSQL', 'postgres:write', 'database']) {
    assert.equal(write.matches(selection), false, `"${selection}" must not activate the write plane`)
  }
})

test('nango key derivation is stable and runtime-matchable', () => {
  assert.deepEqual(fromNangoProviderKey('slack-prod'), { key: 'slack', label: 'Slack', slug: 'slack' })
  assert.deepEqual(fromNangoProviderKey('google-mail'), { key: 'gmail', label: 'Gmail', slug: 'gmail' })
  assert.deepEqual(fromNangoProviderKey('github-app'), { key: 'github', label: 'GitHub', slug: 'github' })
  assert.deepEqual(fromNangoProviderKey('intercom-fhmb'), { key: 'intercom', label: 'Intercom', slug: 'intercom' })
})

test('every delivery capability resolves to a registry connector the runtime can activate', async () => {
  const { DELIVERY_TOOLS } = await import('../../nango/delivery')
  for (const tool of DELIVERY_TOOLS) {
    const connector = nangoConnector(tool.capability)
    assert.ok(connector, `no registry connector for capability ${tool.capability}`)
    assert.equal(connector!.providerId, `nango:${tool.capability}`)
    // A UI chip derived from the capability key must activate the connector.
    assert.equal(isSelected(connector!, [tool.capability]), true)
  }
})
