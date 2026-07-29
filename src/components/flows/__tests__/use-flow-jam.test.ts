import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jamCursorColor } from '../use-flow-jam'
import { reduceJamConnection } from '@/lib/flows/jam-connection'

test('jam cursor colors are stable per teammate', () => {
  assert.equal(jamCursorColor('user-1'), jamCursorColor('user-1'))
  assert.notEqual(jamCursorColor('user-1'), jamCursorColor('user-2'))
})

test('rotating is a visible state, not a silent gap', () => {
  // Between the access change and the reconnect the canvas is identical to
  // "nobody is here". That ambiguity is what made this read as broken.
  assert.equal(reduceJamConnection('connected', 'access-rotating'), 'rotating')
})

test('rotating resolves on the next live channel or snapshot rather than latching', () => {
  assert.equal(reduceJamConnection('rotating', 'snapshot-ok'), 'connected')
  assert.equal(reduceJamConnection('rotating', 'channel-subscribed'), 'connected')
})

test('transport noise during a rotation does not knock it offline', () => {
  assert.equal(reduceJamConnection('rotating', 'channel-closed'), 'rotating')
  assert.equal(reduceJamConnection('rotating', 'delivery-failed'), 'rotating')
})

test('a denial during rotation still wins', () => {
  assert.equal(reduceJamConnection('rotating', 'access-denied'), 'denied')
})
