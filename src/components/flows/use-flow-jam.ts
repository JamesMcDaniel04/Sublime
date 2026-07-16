'use client'

/**
 * Durable Flow Jam collaboration.
 *
 * The API is the sequencer and source of truth; Realtime only accelerates
 * delivery and presence. If WebSockets are blocked or a channel drops, polling
 * catches graph edits up. Local graph changes become id-addressed patches so a
 * teammate editing another node is preserved instead of whole-graph-clobbered.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { FlowGraph } from '@/lib/flows/graph'
import {
  applyFlowCollaborationPatch,
  diffFlowGraphs,
  flowCollaborationPatchSchema,
  patchIsEmpty,
  patchChangesTopology,
} from '@/lib/flows/collaboration'
import { reduceJamConnection, type JamConnectionEvent, type JamConnectionState } from '@/lib/flows/jam-connection'
import { diffPeers, jamCursorSchema, type JamCursor } from '@/lib/flows/jam-presence'
import { huddleSignalSchema, type HuddleSignal } from '@/lib/flows/jam-huddle'

export type { JamConnectionState } from '@/lib/flows/jam-connection'
export type { JamCursor } from '@/lib/flows/jam-presence'
export type { HuddleSignal } from '@/lib/flows/jam-huddle'

export type JamPeer = {
  clientId: string
  userId: string
  name: string
  selectedNodeId: string | null
  cursor: JamCursor | null
  /** Voice huddle membership + mic state, carried on the presence payload. */
  inHuddle: boolean
  huddleMuted: boolean
}

type CollaborationSnapshot = {
  success: boolean
  topic: string
  actor: { userId: string; name: string }
  graph: FlowGraph
  revision: number
  updatedAt: string
  conflicts?: string[]
  error?: string
  code?: string
}

const PATCH_DEBOUNCE_MS = 160
const PREVIEW_THROTTLE_MS = 32
const CURSOR_THROTTLE_MS = 33
// With realtime live, every durable change also broadcasts the FULL graph, so
// the poll is only a safety net for a missed final broadcast — 30s is plenty.
// (Tab-return and revision gaps trigger immediate snapshots on top of this.)
const CONNECTED_POLL_MS = 30000
const DEGRADED_POLL_MS = 1000

/** Parse a peer's cursor off the wire; anything unrecognized renders as none. */
function parsePeerCursor(value: unknown): JamCursor | null {
  const parsed = jamCursorSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export { jamCursorColor } from '@/lib/flows/jam-presence'

function sameGraph(left: FlowGraph | null, right: FlowGraph | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function useFlowJam(options: {
  flowId: string
  enabled: boolean
  selectedNodeId: string | null
  /** Applies server/peer state outside local undo history. */
  onRemoteGraph: (graph: FlowGraph) => void
  onRemoteSaved: (updatedAt: string) => void
  onConflict: (message: string) => void
  /** Presence roster changes (joins/leaves) — the page turns these into toasts. */
  onPeersChanged?: (change: { joined: JamPeer[]; left: JamPeer[] }) => void
  /** Directed WebRTC signaling addressed to THIS client (voice huddle). */
  onHuddleSignal?: (signal: HuddleSignal) => void
}) {
  const { flowId, enabled, selectedNodeId } = options
  const [peers, setPeers] = useState<JamPeer[]>([])
  const peersRef = useRef<JamPeer[]>([])
  const [connectionState, setConnectionState] = useState<JamConnectionState>('connecting')
  const clientId = useMemo(() => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2), [])
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null)
  const actorRef = useRef<{ userId: string; name: string } | null>(null)
  const topicRef = useRef<string | null>(null)
  const baselineRef = useRef<FlowGraph | null>(null)
  const latestLocalRef = useRef<FlowGraph | null>(null)
  const revisionRef = useRef(0)
  const updatedAtRef = useRef<string | null>(null)
  const sendingRef = useRef(false)
  const sessionActiveRef = useRef(false)
  const patchAbortRef = useRef<AbortController | null>(null)
  const patchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorRef = useRef<JamCursor | null>(null)
  // This client's huddle membership — folded into every presence track() so a
  // late joiner learns the huddle roster from the presence sync alone.
  const huddleStateRef = useRef<{ inHuddle: boolean; muted: boolean }>({ inHuddle: false, muted: false })
  const lastCursorSentAtRef = useRef(0)
  const lastPreviewSentAtRef = useRef(0)
  const mutationCounterRef = useRef(0)
  const previewCounterRef = useRef(0)
  const seenPreviewMutationsRef = useRef(new Set<string>())
  const accessDeniedRef = useRef(false)
  const misconfiguredRef = useRef(false)
  const refreshAccessRef = useRef<() => void>(() => {})
  const reconnectRef = useRef<() => void>(() => {})
  const connectionStateRef = useRef<JamConnectionState>('connecting')
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  useEffect(() => {
    connectionStateRef.current = connectionState
  }, [connectionState])

  // Every transition goes through the pure reducer — no ad-hoc state writes,
  // so the connection can never drift into an ambiguous silent state.
  const dispatchConnection = useCallback((event: JamConnectionEvent) => {
    setConnectionState((current) => reduceJamConnection(current, event))
  }, [])

  const disconnectRealtime = () => {
    const channel = channelRef.current
    const supabase = supabaseRef.current
    channelRef.current = null
    supabaseRef.current = null
    if (channel && supabase) void supabase.removeChannel(channel)
    // Our OWN disconnect empties the roster silently — no "left" toasts for
    // peers who are still there from their point of view.
    peersRef.current = []
    setPeers([])
  }

  const markRealtimeDelivery = useCallback((status: string) => {
    if (status !== 'ok') dispatchConnection('delivery-failed')
  }, [dispatchConnection])

  const sendPreview = () => {
    previewTimerRef.current = null
    const channel = channelRef.current
    const baseline = baselineRef.current
    const desired = latestLocalRef.current
    if (!channel || connectionStateRef.current !== 'connected' || !baseline || !desired) return
    const mutationId = `${clientId}:preview:${++previewCounterRef.current}`
    const patch = diffFlowGraphs(baseline, desired, mutationId)
    if (patchIsEmpty(patch)) return
    lastPreviewSentAtRef.current = Date.now()
    void channel.send({
      type: 'broadcast',
      event: 'preview-patch',
      payload: { clientId, baseRevision: revisionRef.current, patch },
    }).then(markRealtimeDelivery)
  }

  const schedulePreview = () => {
    if (!channelRef.current || connectionStateRef.current !== 'connected') return
    const remaining = PREVIEW_THROTTLE_MS - (Date.now() - lastPreviewSentAtRef.current)
    if (remaining <= 0) {
      sendPreview()
      return
    }
    if (!previewTimerRef.current) {
      previewTimerRef.current = setTimeout(sendPreview, remaining)
    }
  }

  const acceptServerGraph = (snapshot: CollaborationSnapshot, allowWhileSending = false) => {
    if (!snapshot.graph || snapshot.revision < revisionRef.current) return
    if (sendingRef.current && !allowWhileSending) return

    const previousBaseline = baselineRef.current
    const pendingLocal = latestLocalRef.current
    let next = snapshot.graph
    if (previousBaseline && pendingLocal && !sameGraph(previousBaseline, pendingLocal)) {
      const pendingPatch = diffFlowGraphs(previousBaseline, pendingLocal, `${clientId}:rebase`)
      next = applyFlowCollaborationPatch(snapshot.graph, pendingPatch).graph
    }

    baselineRef.current = snapshot.graph
    latestLocalRef.current = next
    revisionRef.current = snapshot.revision
    updatedAtRef.current = snapshot.updatedAt
    callbacksRef.current.onRemoteSaved(snapshot.updatedAt)
    if (!sameGraph(next, pendingLocal)) callbacksRef.current.onRemoteGraph(next)
  }

  const scheduleFlush = (delay = PATCH_DEBOUNCE_MS) => {
    // Throttle rather than endlessly debounce: a person typing continuously
    // still sends incremental widget updates to peers every ~160ms.
    if (patchTimerRef.current) return
    patchTimerRef.current = setTimeout(() => {
      patchTimerRef.current = null
      void flushPatch()
    }, delay)
  }

  const flushPatch = async () => {
    if (!enabled || !sessionActiveRef.current || sendingRef.current || accessDeniedRef.current) return
    const baseline = baselineRef.current
    const desired = latestLocalRef.current
    if (!baseline || !desired) return

    const mutationId = `${clientId}:${++mutationCounterRef.current}`
    const patch = diffFlowGraphs(baseline, desired, mutationId)
    if (patchIsEmpty(patch)) return

    sendingRef.current = true
    const abortController = new AbortController()
    patchAbortRef.current = abortController
    const sentGraph = desired
    let retryDelay = 0
    try {
      const response = await fetch(`/api/flows/${flowId}/collaboration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevision: revisionRef.current, patch }),
        signal: abortController.signal,
      })
      const data = (await response.json().catch(() => ({}))) as CollaborationSnapshot

      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          accessDeniedRef.current = true
          disconnectRealtime()
          dispatchConnection('access-denied')
        }
        if (data.graph && typeof data.revision === 'number') {
          baselineRef.current = data.graph
          latestLocalRef.current = data.graph
          revisionRef.current = data.revision
          updatedAtRef.current = data.updatedAt
          callbacksRef.current.onRemoteSaved(data.updatedAt)
          callbacksRef.current.onRemoteGraph(data.graph)
        } else if (!accessDeniedRef.current) {
          retryDelay = 1500
        }
        callbacksRef.current.onConflict(data.error || 'A collaboration edit could not be merged.')
        return
      }

      const localAfterSend = latestLocalRef.current
      let reconciled = data.graph
      if (localAfterSend && !sameGraph(localAfterSend, sentGraph)) {
        const tail = diffFlowGraphs(sentGraph, localAfterSend, `${clientId}:tail`)
        reconciled = applyFlowCollaborationPatch(data.graph, tail).graph
      }

      baselineRef.current = data.graph
      latestLocalRef.current = reconciled
      revisionRef.current = data.revision
      updatedAtRef.current = data.updatedAt
      callbacksRef.current.onRemoteSaved(data.updatedAt)
      if (!sameGraph(reconciled, localAfterSend)) callbacksRef.current.onRemoteGraph(reconciled)
      if (data.conflicts?.length) {
        callbacksRef.current.onConflict('A teammate edited the same step. Your latest change was kept.')
      }

      const channel = channelRef.current
      if (channel) void channel.send({
        type: 'broadcast',
        event: 'graph',
        payload: {
          clientId,
          graph: data.graph,
          revision: data.revision,
          updatedAt: data.updatedAt,
        },
      }).then(markRealtimeDelivery)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      retryDelay = 1500
      dispatchConnection('delivery-failed')
      callbacksRef.current.onConflict('Live sync was interrupted. Your edit is queued and will retry.')
    } finally {
      if (patchAbortRef.current === abortController) patchAbortRef.current = null
      sendingRef.current = false
      if (sessionActiveRef.current && !sameGraph(baselineRef.current, latestLocalRef.current)) {
        scheduleFlush(retryDelay || PATCH_DEBOUNCE_MS)
      }
    }
  }

  useEffect(() => {
    if (!enabled || !flowId) return
    sessionActiveRef.current = true
    accessDeniedRef.current = false
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const loadSnapshot = async (): Promise<CollaborationSnapshot | null> => {
      try {
        const response = await fetch(`/api/flows/${flowId}/collaboration`, { cache: 'no-store' })
        const data = (await response.json().catch(() => ({}))) as CollaborationSnapshot
        if (response.status === 403 || response.status === 404) {
          accessDeniedRef.current = true
          disconnectRealtime()
          if (!disposed) dispatchConnection('access-denied')
        }
        // A deployment without ENCRYPTION_KEY/SUPABASE_SERVICE_ROLE_KEY can't
        // mint channel topics. Tell the user ONCE why Jam is dead instead of
        // showing an eternal silent "Reconnecting" dot, and stop the channel
        // retry loop (regular saves are unaffected).
        if (data.code === 'COLLABORATION_NOT_CONFIGURED') {
          if (!misconfiguredRef.current) {
            misconfiguredRef.current = true
            accessDeniedRef.current = true
            disconnectRealtime()
            callbacksRef.current.onConflict(
              'Live collaboration is not configured on this server (missing ENCRYPTION_KEY). Flow edits still save normally.',
            )
          }
          if (!disposed) dispatchConnection('not-configured')
        }
        if (!response.ok || !data.success) throw new Error(data.error || 'Collaboration unavailable')
        const topicChanged = Boolean(topicRef.current && topicRef.current !== data.topic)
        if (!disposed) {
          // A successful snapshot proves access — clear a stale denial (e.g. the
          // owner re-invited this user mid-session) so patches flow again.
          const regained = accessDeniedRef.current
          accessDeniedRef.current = false
          acceptServerGraph(data)
          dispatchConnection('snapshot-ok')
          if (topicChanged) {
            topicRef.current = data.topic
            reconnectRef.current()
          } else if (regained && !channelRef.current) {
            reconnectRef.current()
          }
        }
        return data
      } catch {
        if (!disposed && !accessDeniedRef.current) dispatchConnection('snapshot-failed')
        return null
      }
    }

    refreshAccessRef.current = () => {
      void loadSnapshot()
    }

    const schedulePoll = () => {
      if (disposed) return
      if (pollTimer) clearTimeout(pollTimer)
      // The fast poll exists to catch up edits while realtime is flaky. When
      // access is denied (or the server can't do collaboration at all) there
      // are no edits to catch — poll slowly, just enough to notice re-grants.
      const delay = connectionStateRef.current === 'connected' || accessDeniedRef.current
        ? CONNECTED_POLL_MS
        : DEGRADED_POLL_MS
      pollTimer = setTimeout(async () => {
        await loadSnapshot()
        schedulePoll()
      }, delay)
    }

    const scheduleReconnect = () => {
      if (disposed || retryTimer || accessDeniedRef.current) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        disconnectRealtime()
        void connect()
      }, 1000)
    }
    reconnectRef.current = scheduleReconnect

    const connect = async () => {
      dispatchConnection('connect-started')
      const snapshot = await loadSnapshot()
      if (disposed || !snapshot) {
        if (!disposed && !accessDeniedRef.current) retryTimer = setTimeout(() => void connect(), 3000)
        return
      }

      actorRef.current = snapshot.actor
      topicRef.current = snapshot.topic
      const supabase = createClient()
      supabaseRef.current = supabase
      const channel = supabase.channel(snapshot.topic, {
        config: {
          private: true,
          broadcast: { self: false, ack: true },
          presence: { key: `${snapshot.actor.userId}:${clientId}` },
        },
      })
      channelRef.current = channel

      channel
        .on('presence', { event: 'sync' }, () => {
          const state = channel.presenceState<JamPeer>()
          const next: JamPeer[] = []
          for (const entries of Object.values(state)) {
            for (const entry of entries) {
              if (entry.clientId && entry.clientId !== clientId) {
                next.push({
                  clientId: entry.clientId,
                  userId: entry.userId,
                  name: entry.name,
                  selectedNodeId: entry.selectedNodeId ?? null,
                  cursor: parsePeerCursor(entry.cursor),
                  inHuddle: entry.inHuddle === true,
                  huddleMuted: entry.huddleMuted === true,
                })
              }
            }
          }
          const change = diffPeers(peersRef.current, next)
          peersRef.current = next
          setPeers(next)
          if (change.joined.length > 0 || change.left.length > 0) {
            callbacksRef.current.onPeersChanged?.(change)
          }
        })
        .on('broadcast', { event: 'cursor' }, ({ payload }) => {
          if (!payload?.clientId || payload.clientId === clientId) return
          setPeers((current) => {
            const next = current.map((peer) =>
              peer.clientId === payload.clientId
                ? { ...peer, cursor: parsePeerCursor(payload.cursor), selectedNodeId: payload.selectedNodeId ?? peer.selectedNodeId }
                : peer,
            )
            peersRef.current = next
            return next
          })
        })
        .on('broadcast', { event: 'preview-patch' }, ({ payload }) => {
          if (!payload || payload.clientId === clientId || typeof payload.baseRevision !== 'number') return
          const parsed = flowCollaborationPatchSchema.safeParse(payload.patch)
          if (!parsed.success) return
          const seen = seenPreviewMutationsRef.current
          if (seen.has(parsed.data.mutationId)) return
          if (seen.size >= 512) seen.clear()
          seen.add(parsed.data.mutationId)
          if (patchChangesTopology(parsed.data) && payload.baseRevision !== revisionRef.current) return
          const current = latestLocalRef.current ?? baselineRef.current
          if (!current) return
          const preview = applyFlowCollaborationPatch(current, parsed.data).graph
          latestLocalRef.current = preview
          if (!sameGraph(preview, current)) callbacksRef.current.onRemoteGraph(preview)
        })
        .on('broadcast', { event: 'graph' }, ({ payload }) => {
          if (!payload || payload.clientId === clientId) return
          if (typeof payload.revision !== 'number' || !payload.graph || typeof payload.updatedAt !== 'string') return
          // Revision gap = we missed at least one broadcast. The full graph in
          // THIS payload self-heals the data, but any preview-patches we applied
          // meanwhile sat on a stale baseline — resync via snapshot to be sure.
          if (revisionRef.current > 0 && payload.revision > revisionRef.current + 1) {
            dispatchConnection('revision-gap')
            refreshAccessRef.current()
          }
          acceptServerGraph({
            success: true,
            topic: snapshot.topic,
            actor: snapshot.actor,
            graph: payload.graph,
            revision: payload.revision,
            updatedAt: payload.updatedAt,
          })
        })
        .on('broadcast', { event: 'access-changed' }, ({ payload }) => {
          if (payload?.clientId === clientId) return
          refreshAccessRef.current()
        })
        .on('broadcast', { event: 'huddle-signal' }, ({ payload }) => {
          // Signaling is directed: the broadcast fans out to everyone, but only
          // the addressee acts. Malformed payloads are dropped, never thrown.
          const parsed = huddleSignalSchema.safeParse(payload)
          if (!parsed.success || parsed.data.to !== clientId || parsed.data.from === clientId) return
          callbacksRef.current.onHuddleSignal?.(parsed.data)
        })
        .subscribe(async (status) => {
          if (disposed) return
          if (status === 'SUBSCRIBED') {
            dispatchConnection('channel-subscribed')
            await channel.track({
              clientId,
              userId: snapshot.actor.userId,
              name: snapshot.actor.name,
              selectedNodeId: callbacksRef.current.selectedNodeId,
              cursor: cursorRef.current,
              inHuddle: huddleStateRef.current.inHuddle,
              huddleMuted: huddleStateRef.current.muted,
            })
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            dispatchConnection('channel-error')
          } else if (status === 'CLOSED') {
            dispatchConnection('channel-closed')
            scheduleReconnect()
          }
        })

      schedulePoll()
    }

    void connect()
    const handleOnline = () => {
      if (!channelRef.current) scheduleReconnect()
      else refreshAccessRef.current()
    }
    // Leaving the tab: flush any unsent edits via sendBeacon — the ONLY
    // transport the browser guarantees to finish after the page is gone.
    // Duplicate delivery is safe: the beacon and a later flushPatch produce
    // value-identical patches (server no-ops the second) and true retries of
    // the same mutationId are deduped by the server's mutation log.
    const flushOnLeave = () => {
      if (accessDeniedRef.current) return
      const baseline = baselineRef.current
      const desired = latestLocalRef.current
      if (!baseline || !desired) return
      const patch = diffFlowGraphs(baseline, desired, `${clientId}:beacon:${++mutationCounterRef.current}`)
      if (patchIsEmpty(patch)) return
      const body = new Blob(
        [JSON.stringify({ baseRevision: revisionRef.current, patch })],
        { type: 'application/json' },
      )
      navigator.sendBeacon?.(`/api/flows/${flowId}/collaboration`, body)
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flushOnLeave()
      // Coming back to the tab: catch up immediately instead of waiting out
      // the (now 30s) live poll.
      else if (!accessDeniedRef.current) refreshAccessRef.current()
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('pagehide', flushOnLeave)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      disposed = true
      sessionActiveRef.current = false
      patchAbortRef.current?.abort()
      patchAbortRef.current = null
      if (retryTimer) clearTimeout(retryTimer)
      if (pollTimer) clearTimeout(pollTimer)
      if (patchTimerRef.current) clearTimeout(patchTimerRef.current)
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current)
      refreshAccessRef.current = () => {}
      reconnectRef.current = () => {}
      topicRef.current = null
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('pagehide', flushOnLeave)
      document.removeEventListener('visibilitychange', handleVisibility)
      disconnectRealtime()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, flowId])

  useEffect(() => {
    const channel = channelRef.current
    const actor = actorRef.current
    if (!channel || !actor || connectionState !== 'connected') return
    void channel.track({
      clientId,
      userId: actor.userId,
      name: actor.name,
      selectedNodeId,
      cursor: cursorRef.current,
      inHuddle: huddleStateRef.current.inHuddle,
      huddleMuted: huddleStateRef.current.muted,
    })
    void channel.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { clientId, cursor: cursorRef.current, selectedNodeId },
    }).then(markRealtimeDelivery)
  }, [clientId, connectionState, selectedNodeId, markRealtimeDelivery])

  const broadcastGraph = (graph: FlowGraph) => {
    latestLocalRef.current = graph
    if (!baselineRef.current) {
      baselineRef.current = graph
      return
    }
    schedulePreview()
    scheduleFlush()
  }

  const sendCursor = () => {
    cursorTimerRef.current = null
    const channel = channelRef.current
    if (!channel) return
    lastCursorSentAtRef.current = Date.now()
    void channel.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { clientId, cursor: cursorRef.current, selectedNodeId },
    }).then(markRealtimeDelivery)
  }

  const updateCursor = (cursor: JamCursor | null) => {
    cursorRef.current = cursor
    const remaining = CURSOR_THROTTLE_MS - (Date.now() - lastCursorSentAtRef.current)
    if (remaining <= 0) {
      sendCursor()
      return
    }
    if (!cursorTimerRef.current) cursorTimerRef.current = setTimeout(sendCursor, remaining)
  }

  const broadcastAccessChange = () => {
    const channel = channelRef.current
    if (!channel) return
    void channel.send({
      type: 'broadcast',
      event: 'access-changed',
      payload: { clientId },
    }).then(markRealtimeDelivery)
    refreshAccessRef.current()
  }

  return { peers, connectionState, broadcastGraph, updateCursor, broadcastAccessChange }
}
