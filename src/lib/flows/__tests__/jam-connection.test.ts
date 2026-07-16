import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceJamConnection, type JamConnectionState } from '../jam-connection'

function replay(start: JamConnectionState, events: Parameters<typeof reduceJamConnection>[1][]): JamConnectionState {
  return events.reduce((state, event) => reduceJamConnection(state, event), start)
}

test('startup: snapshot lands before the channel — HTTP-degraded, then live on subscribe', () => {
  assert.equal(replay('connecting', ['snapshot-ok']), 'degraded')
  assert.equal(replay('connecting', ['snapshot-ok', 'channel-subscribed']), 'connected')
})

test('a revision gap enters catching-up and a successful snapshot returns to live', () => {
  assert.equal(replay('connected', ['revision-gap']), 'catching-up')
  assert.equal(replay('connected', ['revision-gap', 'snapshot-ok']), 'connected')
})

test('failed realtime delivery downgrades live to degraded', () => {
  assert.equal(replay('connected', ['delivery-failed']), 'degraded')
  assert.equal(replay('degraded', ['delivery-failed']), 'degraded')
})

test('channel loss: error degrades, close goes offline, snapshot failure stays offline', () => {
  assert.equal(replay('connected', ['channel-error']), 'degraded')
  assert.equal(replay('connected', ['channel-closed']), 'offline')
  assert.equal(replay('connected', ['channel-closed', 'snapshot-failed']), 'offline')
})

test('reconnect attempt shows connecting, then the ladder back up', () => {
  assert.equal(replay('offline', ['connect-started']), 'connecting')
  assert.equal(replay('offline', ['connect-started', 'snapshot-ok', 'channel-subscribed']), 'connected')
})

test('access denial is sticky against channel noise but clears on a successful snapshot', () => {
  assert.equal(replay('connected', ['access-denied']), 'denied')
  assert.equal(replay('denied', ['channel-error']), 'denied')
  assert.equal(replay('denied', ['channel-closed']), 'denied')
  assert.equal(replay('denied', ['connect-started']), 'denied')
  assert.equal(replay('denied', ['snapshot-ok']), 'degraded')
})

test('unconfigured server is sticky until a snapshot proves otherwise', () => {
  assert.equal(replay('connected', ['not-configured']), 'unconfigured')
  assert.equal(replay('unconfigured', ['snapshot-failed']), 'unconfigured')
  assert.equal(replay('unconfigured', ['connect-started']), 'unconfigured')
  assert.equal(replay('unconfigured', ['snapshot-ok']), 'degraded')
})

test('snapshot-ok never downgrades a live connection', () => {
  assert.equal(replay('connected', ['snapshot-ok']), 'connected')
})
