import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_CONNECTORS, isSelected } from '@/lib/connectors/registry'
import {
  formatFlowToolConnectionId,
  parseFlowToolConnectionId,
} from '@/lib/flows/tool-connection-id'

const descriptor = () => BUILTIN_CONNECTORS.find((c) => c.providerId === 'sublime-goals')

test('the goals connector is registered as a write-capable built-in', () => {
  const goals = descriptor()
  assert.ok(goals, 'sublime-goals is not in BUILTIN_CONNECTORS')
  assert.equal(goals.kind, 'builtin')
  assert.equal(goals.isWrite, true)
  assert.equal(goals.available(), true)
})

test('the goals connector activates only for an agent that selected it', () => {
  const goals = descriptor()!
  assert.equal(isSelected(goals, ['goals']), true)
  assert.equal(isSelected(goals, ['Goals']), true)
  // An agent that never asked for goal access must not receive the tools.
  assert.equal(isSelected(goals, ['slack', 'hubspot']), false)
})

test('the goals connection id round-trips through the plane scheme', () => {
  const id = formatFlowToolConnectionId('native', descriptor()!.providerId)
  assert.equal(id, 'native:sublime-goals')
  assert.deepEqual(parseFlowToolConnectionId(id), { plane: 'native', ref: 'sublime-goals' })
})
