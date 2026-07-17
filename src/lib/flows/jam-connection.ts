/**
 * Flow Jam connection state machine — a pure reducer so every transition is
 * unit-testable and the hook can't drift into ambiguous silent states.
 *
 *   connecting  first load / reconnect attempt in flight
 *   connected   realtime channel live ("Live" in the UI)
 *   catching-up a revision gap was observed; snapshot fetch in flight
 *   degraded    HTTP sync works, realtime doesn't (edits via fallback)
 *   offline     nothing reachable; retrying
 *   denied      server said 403/404 — no access (sticky vs channel noise)
 *   unconfigured server can't do collaboration at all (missing secret; sticky)
 */
export type JamConnectionState =
  | 'connecting'
  | 'connected'
  | 'catching-up'
  | 'degraded'
  | 'offline'
  | 'denied'
  | 'unconfigured'

export type JamConnectionEvent =
  | 'connect-started'
  | 'snapshot-ok'
  | 'snapshot-failed'
  | 'channel-subscribed'
  | 'channel-error'
  | 'channel-closed'
  | 'delivery-failed'
  | 'revision-gap'
  | 'access-denied'
  | 'not-configured'

/** States that ignore ordinary transport noise until access/config resolves. */
const STICKY: ReadonlySet<JamConnectionState> = new Set(['denied', 'unconfigured'])

/**
 * What a failed realtime send may do to the channel (root cause R2 of the
 * jam-stability incident): DURABLE broadcasts (graph, access-changed,
 * comments-changed) prove the pipe is broken when they fail — degrade and
 * rebuild. EPHEMERAL sends (cursor, preview, reaction, spotlight, huddle
 * signaling) fire tens of times per second; a dropped one is self-evident on
 * screen and must NEVER tear down the channel — doing so wiped the presence
 * roster and restarted the join on nearly every mouse move.
 */
export type JamDeliveryKind = 'durable' | 'ephemeral'

export function deliveryAction(kind: JamDeliveryKind, status: string): 'none' | 'reconnect' {
  if (status === 'ok') return 'none'
  return kind === 'durable' ? 'reconnect' : 'none'
}

export function reduceJamConnection(
  state: JamConnectionState,
  event: JamConnectionEvent,
): JamConnectionState {
  // Terminal-ish causes always take over, from anywhere.
  if (event === 'access-denied') return 'denied'
  if (event === 'not-configured') return 'unconfigured'

  if (STICKY.has(state)) {
    // Only proof of access (a successful snapshot) releases a sticky state.
    return event === 'snapshot-ok' ? 'degraded' : state
  }

  switch (event) {
    case 'connect-started':
      return 'connecting'
    case 'snapshot-ok':
      // Proof the HTTP path works. Never downgrades live; completes catch-up.
      return state === 'connected' || state === 'catching-up' ? 'connected' : 'degraded'
    case 'snapshot-failed':
      return 'offline'
    case 'channel-subscribed':
      return 'connected'
    case 'channel-error':
    case 'delivery-failed':
      return 'degraded'
    case 'channel-closed':
      return 'offline'
    case 'revision-gap':
      return 'catching-up'
    default:
      return state
  }
}
