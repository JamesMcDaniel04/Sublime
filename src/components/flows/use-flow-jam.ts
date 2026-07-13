'use client'

/**
 * Durable Flow Jam collaboration.
 *
 * The API is the sequencer and source of truth; Realtime only accelerates
 * delivery and presence. If WebSockets are blocked or a channel drops, polling
 * catches graph edits up. Local graph changes become id-addressed patches so a
 * teammate editing another node is preserved instead of whole-graph-clobbered.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { FlowGraph } from '@/lib/flows/graph'
import {
  applyFlowCollaborationPatch,
  diffFlowGraphs,
  flowCollaborationPatchSchema,
  patchIsEmpty,
  patchChangesTopology,
} from '@/lib/flows/collaboration'

export type JamCursor = { x: number; y: number }
export type JamPeer = {
  clientId: string
  userId: string
  name: string
  selectedNodeId: string | null
  cursor: JamCursor | null
}
export type JamConnectionState = 'connecting' | 'connected' | 'degraded' | 'offline'

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
const CONNECTED_POLL_MS = 5000
const DEGRADED_POLL_MS = 1000

export function normalizeJamCursor(x: number, y: number): JamCursor {
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
}

export function jamCursorColor(userId: string): string {
  let hash = 0
  for (let index = 0; index < userId.length; index++) hash = (hash * 31 + userId.charCodeAt(index)) | 0
  return `hsl(${Math.abs(hash) % 360} 72% 46%)`
}

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
}) {
  const { flowId, enabled, selectedNodeId } = options
  const [peers, setPeers] = useState<JamPeer[]>([])
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
  const lastCursorSentAtRef = useRef(0)
  const lastPreviewSentAtRef = useRef(0)
  const mutationCounterRef = useRef(0)
  const previewCounterRef = useRef(0)
  const seenPreviewMutationsRef = useRef(new Set<string>())
  const accessDeniedRef = useRef(false)
  const refreshAccessRef = useRef<() => void>(() => {})
  const reconnectRef = useRef<() => void>(() => {})
  const connectionStateRef = useRef<JamConnectionState>('connecting')
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  useEffect(() => {
    connectionStateRef.current = connectionState
  }, [connectionState])

  const disconnectRealtime = () => {
    const channel = channelRef.current
    const supabase = supabaseRef.current
    channelRef.current = null
    supabaseRef.current = null
    if (channel && supabase) void supabase.removeChannel(channel)
    setPeers([])
  }

  const markRealtimeDelivery = (status: string) => {
    if (status !== 'ok') {
      setConnectionState((current) => current === 'connected' ? 'degraded' : current)
    }
  }

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
          setConnectionState('offline')
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
      setConnectionState((current) => current === 'connected' ? 'degraded' : 'offline')
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
        }
        if (!response.ok || !data.success) throw new Error(data.error || 'Collaboration unavailable')
        const topicChanged = Boolean(topicRef.current && topicRef.current !== data.topic)
        if (!disposed) {
          acceptServerGraph(data)
          if (connectionStateRef.current !== 'connected') setConnectionState('degraded')
          if (topicChanged) {
            topicRef.current = data.topic
            reconnectRef.current()
          }
        }
        return data
      } catch {
        if (!disposed) setConnectionState('offline')
        return null
      }
    }

    refreshAccessRef.current = () => {
      void loadSnapshot()
    }

    const schedulePoll = () => {
      if (disposed) return
      if (pollTimer) clearTimeout(pollTimer)
      const delay = connectionStateRef.current === 'connected' ? CONNECTED_POLL_MS : DEGRADED_POLL_MS
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
      setConnectionState('connecting')
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
                  cursor: entry.cursor ?? null,
                })
              }
            }
          }
          setPeers(next)
        })
        .on('broadcast', { event: 'cursor' }, ({ payload }) => {
          if (!payload?.clientId || payload.clientId === clientId) return
          setPeers((current) => current.map((peer) =>
            peer.clientId === payload.clientId
              ? { ...peer, cursor: payload.cursor ?? null, selectedNodeId: payload.selectedNodeId ?? peer.selectedNodeId }
              : peer,
          ))
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
        .subscribe(async (status) => {
          if (disposed) return
          if (status === 'SUBSCRIBED') {
            setConnectionState('connected')
            await channel.track({
              clientId,
              userId: snapshot.actor.userId,
              name: snapshot.actor.name,
              selectedNodeId: callbacksRef.current.selectedNodeId,
              cursor: cursorRef.current,
            })
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setConnectionState('degraded')
          } else if (status === 'CLOSED') {
            setConnectionState('offline')
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
    window.addEventListener('online', handleOnline)
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
    })
    void channel.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { clientId, cursor: cursorRef.current, selectedNodeId },
    }).then(markRealtimeDelivery)
  }, [clientId, connectionState, selectedNodeId])

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
    cursorRef.current = cursor ? normalizeJamCursor(cursor.x, cursor.y) : null
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
