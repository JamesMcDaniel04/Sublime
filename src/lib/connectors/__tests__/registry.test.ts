import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_CONNECTORS,
  nangoConnector,
  isSelected,
  isWriteProvider,
  fromNangoProviderKey,
  fromKlavisAgentType,
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
  assert.equal(isWriteProvider('github'), false) // unknown/Klavis read
})

test('every write connector is a delivery plane', () => {
  assert.ok(BUILTIN_CONNECTORS.filter((c) => c.isWrite).every((c) => c.kind === 'builtin' || c.kind === 'nango'))
})

test('nango + klavis key derivation is stable and runtime-matchable', () => {
  assert.deepEqual(fromNangoProviderKey('slack-prod'), { key: 'slack', label: 'Slack', slug: 'slack' })
  assert.deepEqual(fromNangoProviderKey('google-mail'), { key: 'gmail', label: 'Gmail', slug: 'gmail' })
  assert.equal(fromKlavisAgentType('GITHUB').key, 'github')
  assert.equal(fromKlavisAgentType('GOOGLE_DRIVE').slug, 'googledrive')
})
