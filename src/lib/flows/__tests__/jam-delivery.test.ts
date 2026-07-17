import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryAction } from '@/lib/flows/jam-connection'
import { applyCursorEvent, type JamPeerLike } from '@/lib/flows/jam-presence'

// ── deliveryAction: what a failed realtime send may do to the channel ────────
// Root cause R2: cursor/preview sends fire ~30/s; treating ANY failed send as
// channel death caused a permanent teardown/rejoin storm (roster wipes, amber
// flapping, "the jam dies when changes land").

test('durable send failures degrade AND reconnect (broken pipes need a rebuild)', () => {
  assert.equal(deliveryAction('durable', 'timed out'), 'reconnect')
  assert.equal(deliveryAction('durable', 'error'), 'reconnect')
  assert.equal(deliveryAction('durable', 'rate limited'), 'reconnect')
})

test('ephemeral send failures NEVER tear down the channel', () => {
  assert.equal(deliveryAction('ephemeral', 'timed out'), 'none')
  assert.equal(deliveryAction('ephemeral', 'error'), 'none')
})

test('ok is ok', () => {
  assert.equal(deliveryAction('durable', 'ok'), 'none')
  assert.equal(deliveryAction('ephemeral', 'ok'), 'none')
})

// ── applyCursorEvent: self-healing roster ────────────────────────────────────
// Root cause R3: the cursor handler only UPDATED existing peers, so a peer
// whose presence track() was lost stayed invisible forever. Cursor events now
// carry identity and UPSERT the peer.

const cursor = {
  space: 'dag' as const,
  point: { x: 10, y: 20 },
  viewport: { x: 0, y: 0, zoom: 1 },
}

const existing: JamPeerLike = {
  clientId: 'c1', userId: 'u1', name: 'Ada', selectedNodeId: null, cursor: null,
  inHuddle: false, huddleMuted: false,
}

test('updates the cursor of a known peer', () => {
  const next = applyCursorEvent([existing], { clientId: 'c1', userId: 'u1', name: 'Ada', cursor, selectedNodeId: 'n1' }, 'self')
  assert.equal(next.length, 1)
  assert.deepEqual(next[0].cursor, cursor)
  assert.equal(next[0].selectedNodeId, 'n1')
})

test('UPSERTS an unknown peer from a cursor event (presence self-heal)', () => {
  const none: JamPeerLike[] = []
  const next = applyCursorEvent(none, { clientId: 'c2', userId: 'u2', name: 'Grace', cursor, selectedNodeId: null }, 'self')
  assert.equal(next.length, 1)
  assert.equal(next[0].clientId, 'c2')
  assert.equal(next[0].name, 'Grace')
  assert.deepEqual(next[0].cursor, cursor)
})

test('ignores self and identity-less payloads (no ghost peers)', () => {
  const none: JamPeerLike[] = []
  assert.equal(applyCursorEvent(none, { clientId: 'self', userId: 'u', name: 'Me', cursor, selectedNodeId: null }, 'self').length, 0)
  assert.equal(applyCursorEvent(none, { clientId: 'c9', cursor, selectedNodeId: null }, 'self').length, 0)
})

test('malformed cursor payloads clear the cursor but never throw', () => {
  const next = applyCursorEvent([existing], { clientId: 'c1', userId: 'u1', name: 'Ada', cursor: { bogus: true }, selectedNodeId: null }, 'self')
  assert.equal(next[0].cursor, null)
})
