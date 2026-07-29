/**
 * Announce a jam access change, then pick up the rotated channel.
 *
 * The order is the whole point. Changing access bumps
 * `collaborationAccessRevision`, which is baked into the Realtime topic's HMAC,
 * so refreshing rotates the topic and tears down the current channel. If the
 * notice is merely fired and not awaited, that teardown can win the race and
 * peers never learn — they then sit on a dead channel until the 30s poll.
 *
 * It is a race between a fetch and a WebSocket ack, so it varies by network and
 * is likeliest to fail on a FAST connection, where the snapshot returns
 * soonest. That is what makes it feel random and unreproducible.
 *
 * Extracted from the hook so the ordering is testable without a WebSocket.
 */
/** Exactly what this module sends — narrow enough that a RealtimeChannel,
 *  which accepts a broader union, is assignable to it. */
export type AccessNoticePayload = {
  type: 'broadcast'
  event: 'access-changed'
  payload: { clientId: string }
}

export type AccessNoticeDeps = {
  /** Null when the inviter is not in the jam — nobody to notify. */
  getChannel: () => { send: (payload: AccessNoticePayload) => Promise<string> } | null
  clientId: string
  markDurable: (status: string) => void
  refreshAccess: () => void
}

export function makeBroadcastAccessChange(deps: AccessNoticeDeps): () => Promise<void> {
  return async () => {
    const channel = deps.getChannel()
    if (!channel) {
      // Still refresh: the inviter's own topic rotated even with no peers here.
      deps.refreshAccess()
      return
    }
    const status = await channel.send({
      type: 'broadcast',
      event: 'access-changed',
      payload: { clientId: deps.clientId },
    })
    deps.markDurable(status)
    deps.refreshAccess()
  }
}
