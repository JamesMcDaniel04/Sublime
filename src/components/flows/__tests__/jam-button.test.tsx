/**
 * The huddle controls' mount rules. The critical invariant: once the mic is
 * live, the mute/leave controls may NEVER disappear — a transient transport
 * degradation (one timed-out broadcast ack does it) must not strand the user
 * in a hot-mic huddle with no way out.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { JamButton, type JamHuddleControls } from '../jam-button'

afterEach(() => cleanup())

const huddleOf = (active: boolean): JamHuddleControls => ({
  active,
  joining: false,
  muted: false,
  speaking: {},
  mics: [],
  activeMicId: null,
  join: async () => true,
  leave: () => {},
  toggleMute: () => {},
  setMic: async () => true,
})

const baseProps = { flowId: 'f1', peers: [], canManage: false }

test('an ACTIVE huddle keeps its mute/leave controls even when the jam degrades', () => {
  const { container } = render(
    React.createElement(JamButton, { ...baseProps, connectionState: 'degraded', huddle: huddleOf(true) } as never),
  )
  assert.ok(
    container.querySelector('[aria-label="Leave huddle"]'),
    'the mic is hot — leave must stay reachable through transport blips',
  )
  assert.ok(container.querySelector('[aria-label="Mute microphone"]'), 'mute stays reachable too')
})

test('an amber dot explains itself — the failure reason surfaces in the Jam button title', () => {
  const { container } = render(
    React.createElement(JamButton, {
      ...baseProps,
      connectionState: 'degraded',
      connectionDetail: 'Realtime channel failed: Realtime is disabled for this project',
    } as never),
  )
  const jamButton = [...container.querySelectorAll('button')].find((el) =>
    el.getAttribute('title')?.includes('Realtime is disabled for this project'),
  )
  assert.ok(jamButton, 'hovering the dot answers WHY realtime is down, not just that it is')
})

test('a full huddle disables Join instead of overloading the mesh', () => {
  const peers = Array.from({ length: 8 }, (_, index) => ({
    clientId: `c${index}`,
    userId: `u${index}`,
    name: `Peer ${index}`,
    selectedNodeId: null,
    cursor: null,
    inHuddle: true,
    huddleMuted: false,
  }))
  const { container } = render(
    React.createElement(JamButton, { ...baseProps, peers, connectionState: 'connected', huddle: huddleOf(false) } as never),
  )
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes('full'))
  assert.ok(button, 'the join button reads as full')
  assert.equal((button as HTMLButtonElement).disabled, true, 'and cannot be clicked')
})

test('joining a huddle is only offered while the jam is live (signaling needs the channel)', () => {
  const degraded = render(
    React.createElement(JamButton, { ...baseProps, connectionState: 'degraded', huddle: huddleOf(false) } as never),
  )
  assert.doesNotMatch(degraded.container.textContent ?? '', /Huddle/, 'no join button without a signaling rail')
  cleanup()
  const connected = render(
    React.createElement(JamButton, { ...baseProps, connectionState: 'connected', huddle: huddleOf(false) } as never),
  )
  assert.match(connected.container.textContent ?? '', /Huddle/, 'join appears once the channel is live')
})
