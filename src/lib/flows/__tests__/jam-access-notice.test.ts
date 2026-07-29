import test from 'node:test'
import assert from 'node:assert/strict'
import { makeBroadcastAccessChange } from '../jam-access-notice'

test('the notice is flushed before the local refresh can rotate the channel', async () => {
  // The bug: send() needs a WebSocket round-trip while refreshAccess() is a
  // fetch that ends in a reconnect tearing down this very channel. Whichever
  // wins decides whether peers hear about the invite at all — which is why the
  // symptom is intermittent and worst on a fast connection.
  const order: string[] = []
  let ack: (status: string) => void = () => {}
  const channel = {
    send: () =>
      new Promise<string>((resolve) => {
        order.push('send-started')
        ack = (status) => {
          order.push('send-acked')
          resolve(status)
        }
      }),
  }

  const broadcast = makeBroadcastAccessChange({
    getChannel: () => channel,
    clientId: 'c1',
    markDurable: () => order.push('marked'),
    refreshAccess: () => order.push('refresh'),
  })

  const pending = broadcast()
  await Promise.resolve()
  assert.deepEqual(order, ['send-started'], 'the refresh must not run while the notice is in flight')

  ack('ok')
  await pending
  assert.deepEqual(order, ['send-started', 'send-acked', 'marked', 'refresh'])
})

test('with no channel it still refreshes the inviter', async () => {
  // Inviting from outside the jam: nobody to notify, but the inviter must
  // still pick up the rotated topic rather than sitting on a stale one.
  const order: string[] = []
  await makeBroadcastAccessChange({
    getChannel: () => null,
    clientId: 'c1',
    markDurable: () => order.push('marked'),
    refreshAccess: () => order.push('refresh'),
  })()
  assert.deepEqual(order, ['refresh'])
})

test('a failed send still refreshes rather than stranding the inviter', async () => {
  const order: string[] = []
  await makeBroadcastAccessChange({
    getChannel: () => ({ send: async () => 'timed out' }),
    clientId: 'c1',
    markDurable: (status) => order.push(`marked:${status}`),
    refreshAccess: () => order.push('refresh'),
  })()
  assert.deepEqual(order, ['marked:timed out', 'refresh'])
})

test('the payload names the sender so peers can ignore their own notice', () => {
  let sent: any = null
  void makeBroadcastAccessChange({
    getChannel: () => ({ send: async (payload) => { sent = payload; return 'ok' } }),
    clientId: 'c-me',
    markDurable: () => {},
    refreshAccess: () => {},
  })()
  assert.equal(sent.event, 'access-changed')
  assert.equal(sent.payload.clientId, 'c-me')
})
