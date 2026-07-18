/**
 * The WebRTC mesh, tested against the REAL useJamHuddle hook over the
 * fake-webrtc harness: join/leave lifecycle, caller/callee signaling, the
 * handshake deadline (H2), mic devices (H4), autoplay recovery (H5), the
 * disconnected grace (H6), the participant cap (H3), and the
 * offer-beats-presence reconcile grace.
 */
import '@/test-support/jsdom-env'
import { installFakeWebRtc, FakeAudio, FakeMediaStreamTrack, FakeMediaStream, type FakeWebRtc } from '@/test-support/fake-webrtc'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useJamHuddle } from '../use-jam-huddle'
import { HUDDLE_DISCONNECT_GRACE_MS, HUDDLE_SETUP_TIMEOUT_MS, type HuddleSignal } from '@/lib/flows/jam-huddle'
import type { JamPeer } from '../use-flow-jam'

let rtc: FakeWebRtc

beforeEach(() => {
  rtc = installFakeWebRtc()
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  rtc.uninstall()
})

const peerOf = (clientId: string, inHuddle = true): JamPeer => ({
  clientId,
  userId: `user-${clientId}`,
  name: clientId,
  selectedNodeId: null,
  cursor: null,
  inHuddle,
  huddleMuted: false,
})

function setup(initialPeers: JamPeer[] = [], clientId = 'aaa') {
  const signals: HuddleSignal[] = []
  const presence: { inHuddle: boolean; muted: boolean }[] = []
  const view = renderHook(
    ({ peers }: { peers: JamPeer[] }) =>
      useJamHuddle({
        clientId,
        peers,
        sendSignal: (signal) => signals.push(signal),
        setHuddlePresence: (state) => presence.push(state),
      }),
    { initialProps: { peers: initialPeers } },
  )
  return { view, signals, presence }
}

/** join() + settle the async reconcile work (offer creation etc.). */
async function join(view: ReturnType<typeof setup>['view']): Promise<boolean> {
  let ok = false
  await act(async () => {
    ok = await view.result.current.join()
  })
  await act(async () => {})
  return ok
}

test('join acquires the mic, publishes presence, and dials with server-issued ICE', async () => {
  rtc.iceResponse.iceServers = [{ urls: ['turn:relay.example.com:3478'], username: 'u', credential: 'c' }]
  const { view, signals, presence } = setup([peerOf('zzz')])
  assert.equal(await join(view), true)
  assert.equal(view.result.current.active, true)
  assert.deepEqual(presence.at(-1), { inHuddle: true, muted: false })
  // aaa < zzz — we are the caller, so the roster peer got dialed…
  assert.equal(rtc.peers().length, 1)
  assert.equal(signals.filter((signal) => signal.kind === 'offer' && signal.to === 'zzz').length, 1)
  // …over the TURN-capable ICE config the server issued, not the STUN fallback.
  assert.deepEqual(rtc.peers()[0].config.iceServers, rtc.iceResponse.iceServers)
})

test('the callee answers an incoming offer without needing the roster first', async () => {
  const { view, signals } = setup([], 'zzz') // zzz > aaa: we never dial, we answer
  await join(view)
  await act(async () => {
    await view.result.current.handleSignal({ kind: 'offer', from: 'aaa', to: 'zzz', sdp: 'v=0 offer' })
  })
  assert.equal(rtc.peers().length, 1, 'the connection was created on demand')
  assert.ok(rtc.peers()[0].remoteDescription, 'their offer was applied')
  assert.equal(signals.filter((signal) => signal.kind === 'answer' && signal.to === 'aaa').length, 1)
})

test('an offer-created connection survives reconcile until presence confirms the peer', async () => {
  const { view } = setup([peerOf('bbb', false)], 'zzz')
  await join(view)
  await act(async () => {
    await view.result.current.handleSignal({ kind: 'offer', from: 'bbb', to: 'zzz', sdp: 'v=0 offer' })
  })
  const connection = rtc.peers()[0]
  // Presence churn (cursor updates re-deliver the roster) before bbb's
  // inHuddle flag lands — the in-flight handshake must NOT be torn down.
  await act(async () => {
    view.rerender({ peers: [peerOf('bbb', false)] })
  })
  assert.equal(connection.closed, false, 'the reconcile grace held')
  await act(async () => {
    view.rerender({ peers: [peerOf('bbb', true)] })
  })
  assert.equal(connection.closed, false)
  assert.equal(rtc.peers().length, 1, 'presence confirmation does not double-dial')
})

test('H2: an unanswered dial hits the setup deadline and is redialed', async () => {
  const { view } = setup([peerOf('zzz')])
  await join(view)
  const first = rtc.peers()[0]
  assert.equal(first.closed, false)
  await act(async () => {
    assert.equal(rtc.fireTimers(HUDDLE_SETUP_TIMEOUT_MS), 1, 'the deadline was armed')
  })
  await act(async () => {})
  assert.equal(first.closed, true, 'the stuck handshake was torn down')
  assert.equal(rtc.peers().length, 2, 'and the peer was redialed')
})

test('H2: a connected pair clears its setup deadline — no spurious redial', async () => {
  const { view } = setup([peerOf('zzz')])
  await join(view)
  const first = rtc.peers()[0]
  act(() => first.setConnectionState('connected'))
  await act(async () => {
    assert.equal(rtc.fireTimers(HUDDLE_SETUP_TIMEOUT_MS), 0, 'connecting disarmed the deadline')
  })
  assert.equal(first.closed, false)
  assert.equal(rtc.peers().length, 1)
})

test('H6: a lingering `disconnected` connection is redialed after the grace period', async () => {
  const { view } = setup([peerOf('zzz')])
  await join(view)
  const first = rtc.peers()[0]
  act(() => first.setConnectionState('connected'))
  act(() => first.setConnectionState('disconnected'))
  await act(async () => {
    assert.equal(rtc.fireTimers(HUDDLE_DISCONNECT_GRACE_MS), 1, 'the grace timer was armed')
  })
  await act(async () => {})
  assert.equal(first.closed, true, 'the dead pair was torn down without waiting for `failed`')
  assert.equal(rtc.peers().length, 2, 'and redialed')
})

test('H6: a blip that reconnects within the grace period is left alone', async () => {
  const { view } = setup([peerOf('zzz')])
  await join(view)
  const first = rtc.peers()[0]
  act(() => first.setConnectionState('connected'))
  act(() => first.setConnectionState('disconnected'))
  act(() => first.setConnectionState('connected'))
  await act(async () => {
    rtc.fireTimers(HUDDLE_DISCONNECT_GRACE_MS)
  })
  assert.equal(first.closed, false, 'recovery cancelled the redial')
  assert.equal(rtc.peers().length, 1)
})

test('H3: joining a full huddle is refused before the mic is ever touched', async () => {
  const full = Array.from({ length: 8 }, (_, index) => peerOf(`peer-${index}`))
  const { view, presence } = setup(full)
  assert.equal(await join(view), false)
  assert.equal(rtc.mediaDevices.calls.length, 0, 'no permission prompt for a doomed join')
  assert.equal(presence.length, 0, 'and no presence flap')
})

test('a denied microphone fails the join cleanly (no presence, not active)', async () => {
  rtc.mediaDevices.denyWith('NotAllowedError')
  const { view, presence } = setup()
  assert.equal(await join(view), false)
  assert.equal(view.result.current.active, false)
  assert.equal(presence.length, 0)
})

test('H4: the remembered mic is requested as `ideal` — an unplugged device cannot fail the join', async () => {
  window.localStorage.setItem('flows.huddle.micId', 'mic-2')
  const { view } = setup()
  await join(view)
  assert.deepEqual(rtc.mediaDevices.calls[0]?.audio?.deviceId, { ideal: 'mic-2' })
  assert.equal(view.result.current.activeMicId, 'mic-2')
  assert.equal(view.result.current.mics.length, 2, 'the device list is enumerated for the picker')
})

test('H4: switching mics replaces the track on EVERY sender and stops the old one', async () => {
  const { view } = setup([peerOf('zzz')])
  await join(view)
  const oldTrack = rtc.peers()[0].senders[0].track
  let ok = false
  await act(async () => {
    ok = await view.result.current.setMic('mic-2')
  })
  assert.equal(ok, true)
  const sender = rtc.peers()[0].senders[0]
  assert.equal(sender.replacedWith.length, 1, 'the peer hears the new mic without renegotiation')
  assert.equal(sender.replacedWith[0].deviceId, 'mic-2')
  assert.equal((oldTrack as FakeMediaStreamTrack).stopped, true, 'the old mic is released')
  assert.equal(window.localStorage.getItem('flows.huddle.micId'), 'mic-2', 'the choice is remembered')
  assert.equal(view.result.current.activeMicId, 'mic-2')
})

test('H5: blocked autoplay retries every paused stream on the next user gesture', async () => {
  const { view } = setup([], 'zzz')
  await join(view)
  await act(async () => {
    await view.result.current.handleSignal({ kind: 'offer', from: 'aaa', to: 'zzz', sdp: 'v=0 offer' })
  })
  FakeAudio.blockPlayback = true
  await act(async () => {
    rtc.peers()[0].ontrack?.({ streams: [new FakeMediaStream([new FakeMediaStreamTrack('remote')])], track: new FakeMediaStreamTrack('remote') })
    await Promise.resolve()
  })
  const audio = rtc.audios()[0]
  assert.equal(audio.paused, true, 'the browser blocked playback')
  FakeAudio.blockPlayback = false
  await act(async () => {
    window.dispatchEvent(new Event('pointerdown'))
    await Promise.resolve()
  })
  assert.equal(audio.paused, false, 'the next click unblocked the huddle audio')
  assert.ok(audio.playCalls >= 2, 'play was retried, not abandoned')
})

test('leave closes every connection, releases the mic, and clears presence', async () => {
  const { view, presence } = setup([peerOf('zzz')])
  await join(view)
  const connection = rtc.peers()[0]
  const micTrack = connection.senders[0].track as FakeMediaStreamTrack
  act(() => view.result.current.leave())
  assert.equal(connection.closed, true)
  assert.equal(micTrack.stopped, true, 'the mic light goes off')
  assert.deepEqual(presence.at(-1), { inHuddle: false, muted: false })
  assert.equal(view.result.current.active, false)
})
