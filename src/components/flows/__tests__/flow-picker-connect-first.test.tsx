/**
 * Drives the picker's connect-first path for a browsable-but-not-connected
 * connector: picking one of its tools must connect the provider, refresh the
 * catalog, and insert the node using the NEW (real) connection id — never the
 * synthetic browse id.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { FlowPicker } from '../flow-picker'
import { FlowConnectProvider } from '../flow-connect-context'
import type { ToolCatalog } from '../tool-catalog-type'
import type { StepType } from '@/lib/flows/mutate'
import type { FlowInsertSeed } from '../flow-canvas'

afterEach(() => cleanup())

const availableSlack: ToolCatalog[number] = {
  id: 'klavis:available:slack',
  name: 'Slack',
  connected: false,
  connect: { plane: 'klavis', provider: 'slack' },
  tools: [{ name: 'send_message', description: 'Post a message to a channel.' }],
}

const connectedSlack: ToolCatalog[number] = {
  id: 'klavis:agent_123',
  name: 'Slack',
  connected: true,
  tools: [{ name: 'send_message', description: 'Post a message to a channel.', schemaHash: 'h', risk: 'write' }],
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

const findButton = (container: HTMLElement, text: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').includes(text)) as HTMLButtonElement | undefined

test('picking a tool from a not-connected connector connects, then inserts the real connection id', async () => {
  const picks: { type: StepType; seed?: FlowInsertSeed }[] = []
  let connectCalledWith: string | null = null
  let refreshCalled = false

  const value = {
    connectProvider: async (provider: string) => {
      connectCalledWith = provider
      return { ok: true }
    },
    refreshToolCatalog: async () => {
      refreshCalled = true
      return [connectedSlack] as ToolCatalog
    },
  }

  const { container } = render(
    React.createElement(
      FlowConnectProvider,
      { value },
      React.createElement(FlowPicker, {
        mode: 'action' as const,
        agents: [],
        toolCatalog: [availableSlack],
        onPick: (type: StepType, seed?: FlowInsertSeed) => picks.push({ type, seed }),
        onClose: () => {},
      }),
    ),
  )

  // Drill into the not-connected Slack connector.
  const connectorButton = findButton(container, 'Slack')
  assert.ok(connectorButton, 'Slack connector row renders')
  await act(async () => { connectorButton!.click() })

  // Pick its tool (humanized "Send Message").
  const toolButton = findButton(container, 'Send Message') ?? findButton(container, 'Post a message')
  assert.ok(toolButton, 'tool row renders in the drill-in')
  await act(async () => { toolButton!.click() })
  await flush()

  assert.equal(connectCalledWith, 'slack', 'connectProvider called with the provider')
  assert.equal(refreshCalled, true, 'catalog refreshed after connect')
  assert.equal(picks.length, 1, 'exactly one node inserted')
  assert.equal(picks[0].type, 'tool')
  assert.equal(picks[0].seed?.connectionId, 'klavis:agent_123', 'inserts the REAL connection id, not the browse id')
  assert.equal(picks[0].seed?.toolName, 'send_message')
})

test('a failed connect inserts nothing', async () => {
  const picks: { type: StepType; seed?: FlowInsertSeed }[] = []
  const value = {
    connectProvider: async () => ({ ok: false, error: 'nope' }),
    refreshToolCatalog: async () => [] as ToolCatalog,
  }

  const { container } = render(
    React.createElement(
      FlowConnectProvider,
      { value },
      React.createElement(FlowPicker, {
        mode: 'action' as const,
        agents: [],
        toolCatalog: [availableSlack],
        onPick: (type: StepType, seed?: FlowInsertSeed) => picks.push({ type, seed }),
        onClose: () => {},
      }),
    ),
  )

  await act(async () => { findButton(container, 'Slack')!.click() })
  const toolButton = findButton(container, 'Send Message') ?? findButton(container, 'Post a message')
  await act(async () => { toolButton!.click() })
  await flush()

  assert.equal(picks.length, 0, 'no node inserted when connect fails')
})
