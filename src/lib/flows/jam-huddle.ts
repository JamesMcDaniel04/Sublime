/**
 * Flow Jam voice huddle — pure signaling logic + wire types.
 *
 * Audio is a WebRTC mesh (every huddle member peers with every other member,
 * sized for the jam's 2–5 concurrent editors). The existing jam channel is the
 * signaling rail: offers/answers/ICE travel as `huddle-signal` broadcasts, and
 * who-is-in-the-huddle rides the presence payload (`inHuddle`/`huddleMuted`),
 * so a late joiner learns the full huddle roster from the presence sync it
 * already receives. No SFU, no extra vendor.
 */
import { z } from 'zod'

/** Directed signaling messages; `to` filters at the receiver (broadcast rail). */
export const huddleSignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), from: z.string().min(1), to: z.string().min(1), sdp: z.string().min(1) }),
  z.object({ kind: z.literal('answer'), from: z.string().min(1), to: z.string().min(1), sdp: z.string().min(1) }),
  z.object({ kind: z.literal('ice'), from: z.string().min(1), to: z.string().min(1), candidate: z.record(z.string(), z.unknown()) }),
])
export type HuddleSignal = z.infer<typeof huddleSignalSchema>

/**
 * Exactly one side of each pair dials, decided the same way on both ends so
 * simultaneous joins can't produce offer-glare: the lexicographically smaller
 * clientId is the caller. The other side answers when the offer arrives.
 */
export function isHuddleCaller(selfClientId: string, peerClientId: string): boolean {
  return selfClientId < peerClientId
}

/**
 * Reconcile open peer connections against the huddle roster from presence:
 * `open` = in the huddle but not yet connected, `close` = connected but no
 * longer in the huddle (left it, or left the jam entirely).
 *
 * `pending` = peers whose OFFER arrived before the presence sync announcing
 * them. The offer itself proves huddle membership, so those connections are
 * exempt from `close` until presence confirms them or the connection dies —
 * without the grace, reconcile tore down the in-flight handshake and
 * simultaneous joiners sat silent until the ~30s ICE-failure redial.
 */
export function huddleConnectionPlan(
  connected: Iterable<string>,
  roster: Iterable<string>,
  pending: Iterable<string> = [],
): { open: string[]; close: string[] } {
  const current = new Set(connected)
  const target = new Set(roster)
  const grace = new Set(pending)
  return {
    open: [...target].filter((clientId) => !current.has(clientId)),
    close: [...current].filter((clientId) => !target.has(clientId) && !grace.has(clientId)),
  }
}

/**
 * Client-side STUN fallback, used until /api/rtc/ice answers (and forever when
 * the deployment configures no TURN relay — see lib/rtc/ice). TURN is what
 * lets symmetric-NAT / corporate-VPN pairs connect at all.
 */
export const HUDDLE_ICE_SERVERS: { urls: string }[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/**
 * Mesh ceiling: every member holds N-1 connections and uploads audio to each,
 * so cost grows quadratically. Past ~8 members ordinary uplinks audibly
 * degrade for everyone — refuse the 9th instead (an SFU is the real fix
 * beyond this scale).
 */
export const HUDDLE_MAX_PARTICIPANTS = 8

/** May another member join a huddle that currently has `memberCount` people? */
export function huddleHasRoom(memberCount: number): boolean {
  return memberCount < HUDDLE_MAX_PARTICIPANTS
}

/** A handshake that hasn't reached `connected` by this deadline is torn down
 *  and redialed — a lost offer/answer otherwise parks the pair in `new`
 *  forever (connectionState only fails after a connectivity ATTEMPT). */
export const HUDDLE_SETUP_TIMEOUT_MS = 25_000

/** How long a `disconnected` connection may linger before we redial. Browsers
 *  can take 30s+ to promote it to `failed` on their own. */
export const HUDDLE_DISCONNECT_GRACE_MS = 5_000

/** RMS speech gate — mirrors typical voice-activity thresholds for an 8-bit analyser. */
export function isSpeakingLevel(rms: number): boolean {
  return rms > 0.04
}
