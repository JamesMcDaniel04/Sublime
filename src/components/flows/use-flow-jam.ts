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
import { deliveryAction, reduceJamConnection, type JamConnectionEvent, type JamConnectionState, type JamDeliveryKind } from '@/lib/flows/jam-connection'
import { applyCursorEvent, diffPeers, jamCursorSchema, type JamCursor } from '@/lib/flows/jam-presence'
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
  /** Ephemeral emoji reaction from a peer (never persisted). */
  onReaction?: (reaction: { clientId: string; name: string; emoji: string }) => void
  /** A peer asks everyone to follow them — consent toast, never a forced viewport. */
  onSpotlight?: (request: { clientId: string; name: string }) => void
  /** A peer created/resolved/deleted a comment — refetch the thread list. */
  onCommentsChanged?: () => void
}) {
  const { flowId, enabled, selectedNodeId } = options
  const [peers, setPeers] = useState<JamPeer[]>([])
  const peersRef = useRef<JamPeer[]>([])
  const [connectionState, setConnectionState] = useState<JamConnectionState>('connecting')
  /** WHY realtime last failed, for the status UI — null while healthy. An
   *  amber dot with no reason is undebuggable from the browser. */
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null)
  // True once the collaboration endpoint is durably persisting this session's
  // graph (a snapshot landed and access holds). While live, the page's Save
  // must NOT send its whole-graph PUT — the jam patches are the graph's source
  // of truth, and a wholesale overwrite can clobber teammates' work.
  const [graphSyncLive, setGraphSyncLive] = useState(false)
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

  // Delivery policy (see deliveryAction): a failed DURABLE broadcast degrades
  // and rebuilds the channel; a failed EPHEMERAL send (cursor/preview at tens
  // per second) is dropped silently — reconnecting on those tore the channel
  // down on nearly every mouse move, wiping presence and killing the jam.
  const markRealtimeDelivery = useCallback((kind: JamDeliveryKind) => (status: string) => {
    if (deliveryAction(kind, status) === 'reconnect') {
      dispatchConnection('delivery-failed')
      reconnectRef.current()
    }
  }, [dispatchConnection])
  const markDurable = useMemo(() => markRealtimeDelivery('durable'), [markRealtimeDelivery])
  const markEphemeral = useMemo(() => markRealtimeDelivery('ephemeral'), [markRealtimeDelivery])

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
    }).then(markEphemeral)
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
      // A rebase across diverged states can produce a schema-invalid graph and
      // THROW — accept the server graph as-is rather than dying mid-handler
      // (the unsent local delta retries on the next flush from a clean base).
      try {
        const pendingPatch = diffFlowGraphs(previousBaseline, pendingLocal, `${clientId}:rebase`)
        next = applyFlowCollaborationPatch(snapshot.graph, pendingPatch).graph
      } catch (error) {
        console.warn('[flow-jam] local rebase rejected; accepting server graph:', error instanceof Error ? error.message : error)
        next = snapshot.graph
      }
    }

    baselineRef.current = snapshot.graph
    latestLocalRef.current = next
    revisionRef.current = snapshot.revision
    updatedAtRef.current = snapshot.updatedAt
    setGraphSyncLive(true)
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
          setGraphSyncLive(false)
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
      }).then(markDurable)
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
          setGraphSyncLive(false)
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
            setGraphSyncLive(false)
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

    // Consecutive channel failures back the reconnect off (1s → 30s cap) so a
    // persistently rejected join (e.g. Realtime RLS misconfiguration) retries
    // gently instead of hammering the socket once per second.
    let channelFailures = 0
    const scheduleReconnect = () => {
      if (disposed || retryTimer || accessDeniedRef.current) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        disconnectRealtime()
        void connect()
      }, Math.min(30000, 1000 * 2 ** channelFailures))
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
      // A build without the PUBLIC Supabase env can never do realtime, though
      // server snapshots work fine (the server has its own env). createClient
      // THROWS on missing env — uncaught it escaped `void connect()` as an
      // unhandled rejection, stranding the jam on a silent amber 'connecting'
      // with no poll loop at all. Explain once, settle honestly in 'degraded'
      // (HTTP sync IS working), keep polling, and don't dial again.
      let supabase: ReturnType<typeof createClient>
      try {
        supabase = createClient()
      } catch {
        if (disposed) return
        if (!misconfiguredRef.current) {
          misconfiguredRef.current = true
          callbacksRef.current.onConflict(
            'Live collaboration is off: this deployment is missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. Flow edits still save normally.',
          )
        }
        setConnectionDetail('Realtime is off — NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set in this deployment.')
        dispatchConnection('channel-error')
        schedulePoll()
        return
      }
      supabaseRef.current = supabase
      // Private-channel joins are authorized via RLS against the CURRENT
      // realtime auth token. On a fresh client the token loads async — a join
      // sent before it lands is rejected as anon, and each rejection doubled
      // the reconnect backoff (the "green dot takes forever" bug). Block the
      // join on the session token instead of racing it.
      try {
        const { data: sessionData } = await supabase.auth.getSession()
        const token = sessionData.session?.access_token
        if (token) await supabase.realtime.setAuth(token)
      } catch {
        // No session yet — the join will fail and retry on backoff as before.
      }
      if (disposed) return
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
            // UPSERT, not update: a peer whose presence track() was lost would
            // otherwise stay invisible forever (cursor events carry identity —
            // the roster self-heals from them).
            const next = applyCursorEvent(current, payload, clientId)
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
          // Applying onto a diverged local baseline can produce a graph the
          // schema rejects — applyFlowCollaborationPatch THROWS in that case.
          // An uncaught throw here silently stopped the jam applying anything;
          // instead, drop the preview and resync from the server snapshot.
          try {
            const preview = applyFlowCollaborationPatch(current, parsed.data).graph
            latestLocalRef.current = preview
            if (!sameGraph(preview, current)) callbacksRef.current.onRemoteGraph(preview)
          } catch (error) {
            console.warn('[flow-jam] preview patch rejected; resyncing:', error instanceof Error ? error.message : error)
            dispatchConnection('revision-gap')
            refreshAccessRef.current()
          }
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
        .on('broadcast', { event: 'reaction' }, ({ payload }) => {
          if (!payload?.clientId || payload.clientId === clientId) return
          if (typeof payload.emoji !== 'string' || payload.emoji.length === 0 || payload.emoji.length > 8) return
          callbacksRef.current.onReaction?.({
            clientId: payload.clientId,
            name: typeof payload.name === 'string' ? payload.name : 'Teammate',
            emoji: payload.emoji,
          })
        })
        .on('broadcast', { event: 'spotlight' }, ({ payload }) => {
          if (!payload?.clientId || payload.clientId === clientId) return
          callbacksRef.current.onSpotlight?.({
            clientId: payload.clientId,
            name: typeof payload.name === 'string' ? payload.name : 'Teammate',
          })
        })
        .on('broadcast', { event: 'comments-changed' }, ({ payload }) => {
          if (payload?.clientId === clientId) return
          callbacksRef.current.onCommentsChanged?.()
        })
        .subscribe(async (status, err) => {
          // Stale-channel guard: deliberately replacing a channel (reconnect,
          // topic rotation) fires its CLOSED callback — without this check that
          // stale CLOSED would schedule a reconnect against the NEW channel and
          // the teardown/rejoin cycle would repeat forever.
          if (disposed || channelRef.current !== channel) return
          if (status === 'SUBSCRIBED') {
            channelFailures = 0
            setConnectionDetail(null)
            dispatchConnection('channel-subscribed')
            // track() with retry: a single lost track used to make this client
            // permanently invisible to peers (nothing ever re-tracked). Retry
            // a few times, and let the roster's cursor-upsert self-heal the rest.
            const presencePayload = () => ({
              clientId,
              userId: snapshot.actor.userId,
              name: snapshot.actor.name,
              selectedNodeId: callbacksRef.current.selectedNodeId,
              cursor: cursorRef.current,
              inHuddle: huddleStateRef.current.inHuddle,
              huddleMuted: huddleStateRef.current.muted,
            })
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const tracked = await channel.track(presencePayload())
              if (tracked === 'ok' || disposed || channelRef.current !== channel) break
              await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // A join ERROR reply is terminal in realtime-js — unlike socket
            // errors and join timeouts it never schedules a rejoin, so without
            // this reconnect one rejected join leaves the jam on the HTTP
            // fallback (amber dot) for the rest of the session.
            if (err) console.warn('[flow-jam] realtime channel failed:', err.message)
            // Keep the REASON, not just the fact — "amber forever" is usually a
            // rejected private-channel join (RLS/auth) and the server's error
            // message says so.
            setConnectionDetail(
              err ? `Realtime channel failed: ${err.message}`
                : status === 'TIMED_OUT' ? 'Realtime join timed out — retrying.'
                : 'Realtime channel failed — retrying.',
            )
            channelFailures += 1
            dispatchConnection('channel-error')
            scheduleReconnect()
          } else if (status === 'CLOSED') {
            setConnectionDetail('Realtime connection closed — reconnecting.')
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
      payload: { clientId, userId: actor.userId, name: actor.name, cursor: cursorRef.current, selectedNodeId },
    }).then(markEphemeral)
  }, [clientId, connectionState, selectedNodeId, markEphemeral])

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
    const actor = actorRef.current
    // Gate on a live channel: an unjoined channel reroutes broadcasts over
    // per-message HTTP (slow, and rejected for private channels) — at cursor
    // rates that was a request storm feeding the reconnect loop.
    if (!channel || !actor || connectionStateRef.current !== 'connected') return
    lastCursorSentAtRef.current = Date.now()
    void channel.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { clientId, userId: actor.userId, name: actor.name, cursor: cursorRef.current, selectedNodeId },
    }).then(markEphemeral)
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
    }).then(markDurable)
    refreshAccessRef.current()
  }

  /**
   * Send directed WebRTC signaling to a huddle peer over the jam channel.
   *
   * Fire-and-forget BY DESIGN — deliberately NOT chained to
   * markRealtimeDelivery. A huddle join bursts an offer plus trickle-ICE
   * through this channel; one timed-out ack would otherwise degrade the jam
   * and force a full channel rebuild, tearing down the signaling rail MID
   * HANDSHAKE (remaining answers/ICE silently dropped, no audio, huddle UI
   * churn). Voice signaling has its own recovery: the reconcile pass redials
   * when a peer connection fails, so a lost signal costs a retry, not the jam.
   */
  const sendHuddleSignal = (signal: HuddleSignal) => {
    const channel = channelRef.current
    if (!channel) return
    void channel.send({
      type: 'broadcast',
      event: 'huddle-signal',
      payload: signal,
    })
  }

  /** Fire an ephemeral emoji reaction at every peer (never persisted). */
  const sendReaction = (emoji: string) => {
    const channel = channelRef.current
    if (!channel) return
    void channel.send({
      type: 'broadcast',
      event: 'reaction',
      payload: { clientId, name: actorRef.current?.name ?? 'Teammate', emoji },
    }).then(markEphemeral)
  }

  /** Ask every peer to follow this client's viewport (they get a consent toast). */
  const requestSpotlight = () => {
    const channel = channelRef.current
    if (!channel) return
    void channel.send({
      type: 'broadcast',
      event: 'spotlight',
      payload: { clientId, name: actorRef.current?.name ?? 'Teammate' },
    }).then(markEphemeral)
  }

  /** Tell peers the comment list changed so they refetch (fast path vs. bell). */
  const broadcastCommentsChanged = () => {
    const channel = channelRef.current
    if (!channel) return
    void channel.send({
      type: 'broadcast',
      event: 'comments-changed',
      payload: { clientId },
    }).then(markDurable)
  }

  /** Publish this client's huddle membership/mute so peers' rosters update. */
  const setHuddlePresence = (state: { inHuddle: boolean; muted: boolean }) => {
    huddleStateRef.current = state
    const channel = channelRef.current
    const actor = actorRef.current
    if (!channel || !actor) return
    void channel.track({
      clientId,
      userId: actor.userId,
      name: actor.name,
      selectedNodeId: callbacksRef.current.selectedNodeId,
      cursor: cursorRef.current,
      inHuddle: state.inHuddle,
      huddleMuted: state.muted,
    })
  }

  return {
    peers,
    connectionState,
    connectionDetail,
    graphSyncLive,
    clientId,
    broadcastGraph,
    updateCursor,
    broadcastAccessChange,
    sendHuddleSignal,
    setHuddlePresence,
    sendReaction,
    requestSpotlight,
    broadcastCommentsChanged,
  }
}
