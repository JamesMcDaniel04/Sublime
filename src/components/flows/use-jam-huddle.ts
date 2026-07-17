'use client'

/**
 * Flow Jam voice huddle — WebRTC mesh audio for the 2–5 people in a jam.
 *
 * The jam channel does all the signaling (see lib/flows/jam-huddle): offers,
 * answers and ICE travel as directed `huddle-signal` broadcasts, and huddle
 * membership rides the presence payload. Each pair of members holds one
 * RTCPeerConnection; the lexicographically smaller clientId dials so
 * simultaneous joins can't glare. STUN-only — no media server.
 *
 * The page wires the circular dependency with a ref: useFlowJam needs an
 * onHuddleSignal handler, this hook needs useFlowJam's transport. Same pattern
 * as jamCursorUpdateRef.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  HUDDLE_ICE_SERVERS,
  huddleConnectionPlan,
  isHuddleCaller,
  isSpeakingLevel,
  type HuddleSignal,
} from '@/lib/flows/jam-huddle'
import type { JamPeer } from './use-flow-jam'

type PeerEntry = {
  pc: RTCPeerConnection
  audio: HTMLAudioElement | null
  pendingIce: RTCIceCandidateInit[]
  analyser: AnalyserNode | null
  source: MediaStreamAudioSourceNode | null
}

function analyserRms(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (const value of data) {
    const norm = (value - 128) / 128
    sum += norm * norm
  }
  return Math.sqrt(sum / data.length)
}

export function useJamHuddle(options: {
  clientId: string
  peers: JamPeer[]
  sendSignal: (signal: HuddleSignal) => void
  setHuddlePresence: (state: { inHuddle: boolean; muted: boolean }) => void
}) {
  const { clientId, peers } = options
  const [active, setActive] = useState(false)
  const [joining, setJoining] = useState(false)
  const [muted, setMuted] = useState(false)
  /** clientId → currently speaking (plus 'self' for the local mic). */
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({})
  // Bumped when a connection dies so the reconcile pass runs again (one retry
  // per failure; ICE failure itself is slow, so this can't hot-loop).
  const [reconcileTick, setReconcileTick] = useState(0)

  const activeRef = useRef(false)
  const mutedRef = useRef(false)
  const localStreamRef = useRef<MediaStream | null>(null)
  const connectionsRef = useRef(new Map<string, PeerEntry>())
  // Peers whose offer beat the presence sync announcing them — exempt from the
  // reconcile close until presence confirms them (see huddleConnectionPlan).
  const pendingOffersRef = useRef(new Set<string>())
  const audioContextRef = useRef<AudioContext | null>(null)
  const selfAnalyserRef = useRef<AnalyserNode | null>(null)
  const sendSignalRef = useRef(options.sendSignal)
  sendSignalRef.current = options.sendSignal
  const setHuddlePresenceRef = useRef(options.setHuddlePresence)
  setHuddlePresenceRef.current = options.setHuddlePresence

  /** Lazily shared AudioContext; metering is best-effort and never fatal. */
  const attachAnalyser = (stream: MediaStream): { analyser: AnalyserNode; source: MediaStreamAudioSourceNode } => {
    const context = audioContextRef.current ?? new AudioContext()
    audioContextRef.current = context
    void context.resume().catch(() => undefined)
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    return { analyser, source }
  }

  const closeConnection = (peerId: string) => {
    pendingOffersRef.current.delete(peerId)
    const entry = connectionsRef.current.get(peerId)
    if (!entry) return
    connectionsRef.current.delete(peerId)
    try { entry.source?.disconnect() } catch { /* context already closed */ }
    entry.pc.onicecandidate = null
    entry.pc.ontrack = null
    entry.pc.onconnectionstatechange = null
    try { entry.pc.close() } catch { /* already closed */ }
    if (entry.audio) {
      entry.audio.pause()
      entry.audio.srcObject = null
    }
  }

  const createConnection = (peerId: string): PeerEntry => {
    const existing = connectionsRef.current.get(peerId)
    if (existing) return existing
    const pc = new RTCPeerConnection({ iceServers: HUDDLE_ICE_SERVERS })
    const entry: PeerEntry = { pc, audio: null, pendingIce: [], analyser: null, source: null }
    connectionsRef.current.set(peerId, entry)
    const local = localStreamRef.current
    if (local) for (const track of local.getTracks()) pc.addTrack(track, local)
    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      sendSignalRef.current({
        kind: 'ice',
        from: clientId,
        to: peerId,
        candidate: event.candidate.toJSON() as Record<string, unknown>,
      })
    }
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      const audio = entry.audio ?? new Audio()
      audio.autoplay = true
      audio.srcObject = stream
      void audio.play().catch(() => undefined)
      entry.audio = audio
      try {
        const tap = attachAnalyser(stream)
        entry.analyser = tap.analyser
        entry.source = tap.source
      } catch { /* metering only */ }
    }
    pc.onconnectionstatechange = () => {
      // STUN-only mesh: a symmetric-NAT pair may fail outright. Tear down and
      // let the reconcile pass redial — repeated failures just stay silent for
      // that one pair instead of killing the whole huddle.
      if (pc.connectionState === 'failed') {
        closeConnection(peerId)
        setReconcileTick((tick) => tick + 1)
      }
    }
    return entry
  }

  const flushPendingIce = async (entry: PeerEntry) => {
    const queued = entry.pendingIce.splice(0, entry.pendingIce.length)
    for (const candidate of queued) {
      await entry.pc.addIceCandidate(candidate).catch(() => undefined)
    }
  }

  /** Incoming directed signaling — the page routes useFlowJam's onHuddleSignal here. */
  const handleSignal = useCallback(async (signal: HuddleSignal) => {
    if (!activeRef.current) return
    // An offer may beat the presence sync that announces the peer — create the
    // connection on demand; answers/ICE for unknown peers are stale, drop them.
    // Mark on-demand creations pending so the reconcile pass (which trusts the
    // presence roster) doesn't close this handshake in the propagation gap.
    if (signal.kind === 'offer' && !connectionsRef.current.has(signal.from)) {
      pendingOffersRef.current.add(signal.from)
    }
    const entry = signal.kind === 'offer' ? createConnection(signal.from) : connectionsRef.current.get(signal.from)
    if (!entry) return
    try {
      if (signal.kind === 'offer') {
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        await flushPendingIce(entry)
        const answer = await entry.pc.createAnswer()
        await entry.pc.setLocalDescription(answer)
        sendSignalRef.current({ kind: 'answer', from: clientId, to: signal.from, sdp: answer.sdp ?? '' })
      } else if (signal.kind === 'answer') {
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        await flushPendingIce(entry)
      } else if (entry.pc.remoteDescription) {
        await entry.pc.addIceCandidate(signal.candidate as RTCIceCandidateInit)
      } else {
        entry.pendingIce.push(signal.candidate as RTCIceCandidateInit)
      }
    } catch {
      // A torn-down or mid-renegotiation connection; the reconcile pass redials.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  // Reconcile open connections against the huddle roster from presence. Only
  // the deterministic caller dials; the callee's connection is created when
  // the offer arrives (see handleSignal).
  useEffect(() => {
    if (!active) return
    const roster = peers.filter((peer) => peer.inHuddle).map((peer) => peer.clientId)
    // Presence has caught up for these peers — their grace period is over.
    for (const peerId of roster) pendingOffersRef.current.delete(peerId)
    const plan = huddleConnectionPlan(connectionsRef.current.keys(), roster, pendingOffersRef.current)
    for (const peerId of plan.close) closeConnection(peerId)
    for (const peerId of plan.open) {
      if (!isHuddleCaller(clientId, peerId)) continue
      const entry = createConnection(peerId)
      void (async () => {
        try {
          const offer = await entry.pc.createOffer()
          await entry.pc.setLocalDescription(offer)
          sendSignalRef.current({ kind: 'offer', from: clientId, to: peerId, sdp: offer.sdp ?? '' })
        } catch {
          closeConnection(peerId)
        }
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, peers, clientId, reconcileTick])

  // Speaking meter: one shared ticker over every analyser; state only changes
  // when someone's speaking flag actually flips (no 150ms re-render churn).
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      const next: Record<string, boolean> = {}
      const self = selfAnalyserRef.current
      if (self && !mutedRef.current) next.self = isSpeakingLevel(analyserRms(self))
      for (const [peerId, entry] of connectionsRef.current) {
        if (entry.analyser) next[peerId] = isSpeakingLevel(analyserRms(entry.analyser))
      }
      setSpeaking((current) => {
        const keys = new Set([...Object.keys(current), ...Object.keys(next)])
        for (const key of keys) {
          if (Boolean(current[key]) !== Boolean(next[key])) return next
        }
        return current
      })
    }, 150)
    return () => window.clearInterval(timer)
  }, [active])

  /** Join the huddle. Resolves false when the mic is unavailable/denied. */
  const join = useCallback(async (): Promise<boolean> => {
    if (activeRef.current || joining) return activeRef.current
    setJoining(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      localStreamRef.current = stream
      try {
        selfAnalyserRef.current = attachAnalyser(stream).analyser
      } catch { /* metering only */ }
      activeRef.current = true
      mutedRef.current = false
      setActive(true)
      setMuted(false)
      setHuddlePresenceRef.current({ inHuddle: true, muted: false })
      return true
    } catch {
      return false
    } finally {
      setJoining(false)
    }
  }, [joining])

  const leave = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = false
    mutedRef.current = false
    setActive(false)
    setMuted(false)
    setSpeaking({})
    for (const peerId of connectionsRef.current.keys()) closeConnection(peerId)
    const stream = localStreamRef.current
    localStreamRef.current = null
    if (stream) for (const track of stream.getTracks()) track.stop()
    selfAnalyserRef.current = null
    const context = audioContextRef.current
    audioContextRef.current = null
    if (context) void context.close().catch(() => undefined)
    setHuddlePresenceRef.current({ inHuddle: false, muted: false })
  }, [])

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream || !activeRef.current) return
    const next = !mutedRef.current
    mutedRef.current = next
    for (const track of stream.getAudioTracks()) track.enabled = !next
    setMuted(next)
    setHuddlePresenceRef.current({ inHuddle: true, muted: next })
  }, [])

  // Navigating away mid-huddle must release the microphone.
  const leaveRef = useRef(leave)
  leaveRef.current = leave
  useEffect(() => () => leaveRef.current(), [])

  return { active, joining, muted, speaking, join, leave, toggleMute, handleSignal }
}
