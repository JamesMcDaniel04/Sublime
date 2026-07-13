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
  patchIsEmpty,
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
const CURSOR_THROTTLE_MS = 50
const POLL_MS = 2500

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
  const baselineRef = useRef<FlowGraph | null>(null)
  const latestLocalRef = useRef<FlowGraph | null>(null)
  const revisionRef = useRef(0)
  const updatedAtRef = useRef<string | null>(null)
  const sendingRef = useRef(false)
  const patchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorRef = useRef<JamCursor | null>(null)
  const mutationCounterRef = useRef(0)
  const accessDeniedRef = useRef(false)
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  const disconnectRealtime = () => {
    const channel = channelRef.current
    const supabase = supabaseRef.current
    channelRef.current = null
    supabaseRef.current = null
    if (channel && supabase) void supabase.removeChannel(channel)
    setPeers([])
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
    if (!enabled || sendingRef.current || accessDeniedRef.current) return
    const baseline = baselineRef.current
    const desired = latestLocalRef.current
    if (!baseline || !desired) return

    const mutationId = `${clientId}:${++mutationCounterRef.current}`
    const patch = diffFlowGraphs(baseline, desired, mutationId)
    if (patchIsEmpty(patch)) return

    sendingRef.current = true
    const sentGraph = desired
    let retryDelay = 0
    try {
      const response = await fetch(`/api/flows/${flowId}/collaboration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevision: revisionRef.current, patch }),
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

      void channelRef.current?.send({
        type: 'broadcast',
        event: 'graph',
        payload: {
          clientId,
          graph: data.graph,
          revision: data.revision,
          updatedAt: data.updatedAt,
        },
      })
    } catch {
      retryDelay = 1500
      setConnectionState((current) => current === 'connected' ? 'degraded' : 'offline')
      callbacksRef.current.onConflict('Live sync was interrupted. Your edit is queued and will retry.')
    } finally {
      sendingRef.current = false
      if (!sameGraph(baselineRef.current, latestLocalRef.current)) scheduleFlush(retryDelay || PATCH_DEBOUNCE_MS)
    }
  }

  useEffect(() => {
    if (!enabled || !flowId) return
    accessDeniedRef.current = false
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const loadSnapshot = async (): Promise<CollaborationSnapshot | null> => {
      try {
        const response = await fetch(`/api/flows/${flowId}/collaboration`, { cache: 'no-store' })
        const data = (await response.json().catch(() => ({}))) as CollaborationSnapshot
        if (response.status === 403 || response.status === 404) {
          accessDeniedRef.current = true
          disconnectRealtime()
        }
        if (!response.ok || !data.success) throw new Error(data.error || 'Collaboration unavailable')
        if (!disposed) acceptServerGraph(data)
        return data
      } catch {
        if (!disposed) setConnectionState('offline')
        return null
      }
    }

    const connect = async () => {
      setConnectionState('connecting')
      const snapshot = await loadSnapshot()
      if (disposed || !snapshot) {
        if (!disposed && !accessDeniedRef.current) retryTimer = setTimeout(() => void connect(), 3000)
        return
      }

      actorRef.current = snapshot.actor
      const supabase = createClient()
      supabaseRef.current = supabase
      const channel = supabase.channel(snapshot.topic, {
        config: { broadcast: { self: false }, presence: { key: `${snapshot.actor.userId}:${clientId}` } },
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
          }
        })

      pollTimer = setInterval(() => void loadSnapshot(), POLL_MS)
    }

    void connect()
    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (patchTimerRef.current) clearTimeout(patchTimerRef.current)
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current)
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
  }, [clientId, connectionState, selectedNodeId])

  const broadcastGraph = (graph: FlowGraph) => {
    latestLocalRef.current = graph
    if (!baselineRef.current) {
      baselineRef.current = graph
      return
    }
    scheduleFlush()
  }

  const updateCursor = (cursor: JamCursor | null) => {
    cursorRef.current = cursor ? normalizeJamCursor(cursor.x, cursor.y) : null
    if (cursorTimerRef.current) return
    cursorTimerRef.current = setTimeout(() => {
      cursorTimerRef.current = null
      void channelRef.current?.send({
        type: 'broadcast',
        event: 'cursor',
        payload: { clientId, cursor: cursorRef.current, selectedNodeId },
      })
    }, CURSOR_THROTTLE_MS)
  }

  return { peers, connectionState, broadcastGraph, updateCursor }
}
