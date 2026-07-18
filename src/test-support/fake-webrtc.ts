/**
 * Fake WebRTC environment for testing useJamHuddle against the REAL hook
 * implementation — controllable RTCPeerConnection / mediaDevices / Audio /
 * AudioContext / MediaStream, an /api/rtc/ice fetch stub, and a timer trap.
 *
 * The timer trap intercepts ONLY the huddle's two deadline delays (setup
 * timeout, disconnected grace) on window.setTimeout, so tests fire them
 * deterministically while React's own timers keep running for real — a full
 * fake clock would break rendering.
 *
 * Import AFTER jsdom-env (window must exist).
 */
import { HUDDLE_DISCONNECT_GRACE_MS, HUDDLE_SETUP_TIMEOUT_MS } from '@/lib/flows/jam-huddle'

export class FakeMediaStreamTrack {
  kind = 'audio'
  enabled = true
  stopped = false
  constructor(readonly deviceId: string = 'default-mic') {}
  stop() { this.stopped = true }
  getSettings() { return { deviceId: this.deviceId } }
}

export class FakeMediaStream {
  constructor(readonly tracks: FakeMediaStreamTrack[] = []) {}
  getTracks() { return this.tracks }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio') }
}

type FakeSender = { track: FakeMediaStreamTrack | null; replacedWith: FakeMediaStreamTrack[]; replaceTrack: (track: FakeMediaStreamTrack) => Promise<void> }

export class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = []
  connectionState = 'new'
  closed = false
  localDescription: unknown = null
  remoteDescription: unknown = null
  addedIce: unknown[] = []
  senders: FakeSender[] = []
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null
  ontrack: ((event: { streams: FakeMediaStream[]; track: FakeMediaStreamTrack }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  constructor(readonly config: { iceServers?: unknown[] }) {
    FakeRTCPeerConnection.instances.push(this)
  }
  addTrack(track: FakeMediaStreamTrack) {
    const sender: FakeSender = {
      track,
      replacedWith: [],
      replaceTrack: async (next) => {
        sender.replacedWith.push(next)
        sender.track = next
      },
    }
    this.senders.push(sender)
    return sender
  }
  getSenders() { return this.senders }
  async createOffer() { return { type: 'offer', sdp: 'v=0 fake-offer' } }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 fake-answer' } }
  async setLocalDescription(description: unknown) { this.localDescription = description }
  async setRemoteDescription(description: unknown) { this.remoteDescription = description }
  async addIceCandidate(candidate: unknown) { this.addedIce.push(candidate) }
  close() {
    this.closed = true
    this.connectionState = 'closed'
  }
  /** Test control: drive connectionState and fire the hook's listener. */
  setConnectionState(state: string) {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
}

export class FakeAudio {
  static instances: FakeAudio[] = []
  /** While true, play() rejects like a browser autoplay block. */
  static blockPlayback = false
  paused = true
  autoplay = false
  srcObject: unknown = null
  playCalls = 0
  constructor() { FakeAudio.instances.push(this) }
  async play() {
    this.playCalls += 1
    if (FakeAudio.blockPlayback) throw new DOMException('play() blocked', 'NotAllowedError')
    this.paused = false
  }
  pause() { this.paused = true }
}

class FakeAudioContext {
  async resume() {}
  async close() {}
  createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} } }
  createAnalyser() {
    return { fftSize: 256, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }
  }
}

export type FakeWebRtc = {
  peers: () => FakeRTCPeerConnection[]
  audios: () => FakeAudio[]
  mediaDevices: {
    /** Constraints of every getUserMedia call, in order. */
    calls: { audio?: { deviceId?: { ideal?: string; exact?: string } } }[]
    /** Make the next getUserMedia calls reject with this DOMException name. */
    denyWith: (name: string | null) => void
    setDevices: (devices: { deviceId: string; label: string }[]) => void
    dispatchDeviceChange: () => void
  }
  /** What /api/rtc/ice returns. */
  iceResponse: { iceServers: unknown[] }
  /** Fire trapped deadline timers with this delay; returns how many fired. */
  fireTimers: (delay: number) => number
  uninstall: () => void
}

const TRAPPED_DELAYS = new Set<number>([HUDDLE_SETUP_TIMEOUT_MS, HUDDLE_DISCONNECT_GRACE_MS])

export function installFakeWebRtc(): FakeWebRtc {
  const win = window as unknown as Record<string, unknown>
  const g = globalThis as unknown as Record<string, unknown>
  const saved = {
    RTCPeerConnection: g.RTCPeerConnection,
    Audio: g.Audio,
    AudioContext: g.AudioContext,
    MediaStream: g.MediaStream,
    fetch: g.fetch,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    mediaDevices: Object.getOwnPropertyDescriptor(window.navigator, 'mediaDevices'),
  }

  FakeRTCPeerConnection.instances = []
  FakeAudio.instances = []
  FakeAudio.blockPlayback = false

  for (const target of [g, win]) {
    target.RTCPeerConnection = FakeRTCPeerConnection
    target.Audio = FakeAudio
    target.AudioContext = FakeAudioContext
    target.MediaStream = FakeMediaStream
  }

  // ── mediaDevices ──────────────────────────────────────────────────────────
  const gumCalls: FakeWebRtc['mediaDevices']['calls'] = []
  let denyName: string | null = null
  let deviceList = [
    { deviceId: 'mic-1', label: 'Built-in Microphone' },
    { deviceId: 'mic-2', label: 'USB Headset' },
  ]
  const changeListeners = new Set<() => void>()
  const mediaDevices = {
    getUserMedia: async (constraints: { audio?: { deviceId?: { ideal?: string; exact?: string } } }) => {
      gumCalls.push(constraints)
      if (denyName) throw new DOMException('getUserMedia denied', denyName)
      const requested = constraints.audio?.deviceId?.exact ?? constraints.audio?.deviceId?.ideal ?? 'default-mic'
      return new FakeMediaStream([new FakeMediaStreamTrack(requested)])
    },
    enumerateDevices: async () => deviceList.map((device) => ({ ...device, kind: 'audioinput' })),
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'devicechange') changeListeners.add(listener)
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'devicechange') changeListeners.delete(listener)
    },
  }
  Object.defineProperty(window.navigator, 'mediaDevices', { value: mediaDevices, configurable: true })

  // ── /api/rtc/ice ──────────────────────────────────────────────────────────
  const iceResponse: FakeWebRtc['iceResponse'] = { iceServers: [{ urls: ['stun:stun.example.com'] }] }
  g.fetch = (async (input: unknown) => {
    if (String(input).includes('/api/rtc/ice')) {
      return new Response(JSON.stringify({ success: true, iceServers: iceResponse.iceServers }))
    }
    throw new Error(`fake-webrtc: unexpected fetch ${String(input)}`)
  }) as typeof fetch

  // ── deadline timer trap ───────────────────────────────────────────────────
  const trapped = new Map<number, { cb: () => void; delay: number }>()
  let nextTrapId = -1
  window.setTimeout = ((cb: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== undefined && TRAPPED_DELAYS.has(delay)) {
      const id = nextTrapId--
      trapped.set(id, { cb, delay })
      return id
    }
    return (saved.setTimeout as typeof window.setTimeout)(cb as () => void, delay, ...(args as []))
  }) as typeof window.setTimeout
  window.clearTimeout = ((id?: number) => {
    if (typeof id === 'number' && trapped.delete(id)) return
    ;(saved.clearTimeout as typeof window.clearTimeout)(id)
  }) as typeof window.clearTimeout

  return {
    peers: () => FakeRTCPeerConnection.instances,
    audios: () => FakeAudio.instances,
    mediaDevices: {
      calls: gumCalls,
      denyWith: (name) => { denyName = name },
      setDevices: (devices) => { deviceList = devices },
      dispatchDeviceChange: () => { for (const listener of changeListeners) listener() },
    },
    iceResponse,
    fireTimers: (delay) => {
      const due = [...trapped.entries()].filter(([, timer]) => timer.delay === delay)
      for (const [id, timer] of due) {
        trapped.delete(id)
        timer.cb()
      }
      return due.length
    },
    uninstall: () => {
      for (const target of [g, win]) {
        target.RTCPeerConnection = saved.RTCPeerConnection
        target.Audio = saved.Audio
        target.AudioContext = saved.AudioContext
        target.MediaStream = saved.MediaStream
      }
      g.fetch = saved.fetch
      window.setTimeout = saved.setTimeout
      window.clearTimeout = saved.clearTimeout
      if (saved.mediaDevices) Object.defineProperty(window.navigator, 'mediaDevices', saved.mediaDevices)
      else Reflect.deleteProperty(window.navigator, 'mediaDevices')
    },
  }
}
