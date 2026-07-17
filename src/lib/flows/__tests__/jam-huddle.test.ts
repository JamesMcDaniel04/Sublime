import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HUDDLE_MAX_PARTICIPANTS,
  huddleConnectionPlan,
  huddleHasRoom,
  huddleSignalSchema,
  isHuddleCaller,
  isSpeakingLevel,
} from '../jam-huddle'

test('exactly one side of every pair is the caller, decided identically on both ends', () => {
  assert.equal(isHuddleCaller('aaa', 'bbb'), true)
  assert.equal(isHuddleCaller('bbb', 'aaa'), false)
  // Symmetry: the two ends never both dial, and never both wait.
  for (const [a, b] of [['client-1', 'client-2'], ['zzz', 'aab'], ['x', 'y']]) {
    assert.equal(isHuddleCaller(a, b), !isHuddleCaller(b, a))
  }
})

test('huddleConnectionPlan opens missing peers and closes departed ones', () => {
  const plan = huddleConnectionPlan(['a', 'b', 'c'], ['b', 'c', 'd'])
  assert.deepEqual(plan, { open: ['d'], close: ['a'] })
})

test('huddleConnectionPlan is empty when connections already match the roster', () => {
  assert.deepEqual(huddleConnectionPlan(['a', 'b'], ['b', 'a']), { open: [], close: [] })
})

test('huddleConnectionPlan closes everything when the roster empties', () => {
  assert.deepEqual(huddleConnectionPlan(['a', 'b'], []), { open: [], close: ['a', 'b'] })
})

test('a pending offer-created connection survives reconcile while presence lags', () => {
  // 'b' dialed us — their offer PROVES they are in the huddle — but their
  // inHuddle presence flag has not landed yet. Closing that in-flight
  // handshake silenced simultaneous joins until the ~30s ICE timeout redial.
  const plan = huddleConnectionPlan(['a', 'b'], ['a'], ['b'])
  assert.deepEqual(plan, { open: [], close: [] })
})

test('pending is a grace for the offer sender only — other absentees still close', () => {
  const plan = huddleConnectionPlan(['a', 'b', 'c'], ['a'], ['b'])
  assert.deepEqual(plan, { open: [], close: ['c'] }, 'c left the huddle; b is mid-handshake')
})

test('a pending peer confirmed by the roster needs no special treatment', () => {
  assert.deepEqual(huddleConnectionPlan(['a', 'b'], ['a', 'b'], ['b']), { open: [], close: [] })
})

test('signal schema accepts offer/answer/ice and rejects unknown kinds', () => {
  assert.equal(huddleSignalSchema.safeParse({ kind: 'offer', from: 'a', to: 'b', sdp: 'v=0…' }).success, true)
  assert.equal(huddleSignalSchema.safeParse({ kind: 'answer', from: 'a', to: 'b', sdp: 'v=0…' }).success, true)
  assert.equal(
    huddleSignalSchema.safeParse({ kind: 'ice', from: 'a', to: 'b', candidate: { candidate: 'candidate:1', sdpMid: '0' } }).success,
    true,
  )
  assert.equal(huddleSignalSchema.safeParse({ kind: 'hangup', from: 'a', to: 'b' }).success, false)
  assert.equal(huddleSignalSchema.safeParse({ kind: 'offer', from: 'a', sdp: 'v=0…' }).success, false)
})

test('the mesh has a hard participant ceiling — joining a full huddle is refused', () => {
  // A full mesh is N×(N-1)/2 connections with one audio uplink per peer;
  // beyond ~8 members ordinary uplinks audibly degrade for everyone.
  assert.equal(huddleHasRoom(0), true)
  assert.equal(huddleHasRoom(HUDDLE_MAX_PARTICIPANTS - 1), true, 'the last seat is joinable')
  assert.equal(huddleHasRoom(HUDDLE_MAX_PARTICIPANTS), false, 'a full huddle refuses the next joiner')
})

test('speech gate passes voice-level RMS and rejects silence-level noise', () => {
  assert.equal(isSpeakingLevel(0.005), false)
  assert.equal(isSpeakingLevel(0.12), true)
})
