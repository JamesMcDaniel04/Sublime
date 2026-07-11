'use client'

/**
 * Flow Jam: real-time co-editing presence + graph sync for the builder.
 *
 * One Supabase Realtime channel per flow (`flow-jam:<flowId>`, websocket —
 * no polling, edits land on peers in tens of ms):
 *  - presence: { userId, name, selectedNodeId } → avatar stack + per-node
 *    "who's editing" badges
 *  - broadcast 'graph': debounced full-graph payload after every local edit
 *    (flow graphs are KB-scale; whole-state sync beats op-rebase complexity
 *    for v1 and can't diverge)
 *  - broadcast 'saved': the saver's new updatedAt, so peers refresh their
 *    optimistic-concurrency base and their own next save doesn't 409
 *
 * Own events are filtered by clientId (and `self: false`); remote graphs are
 * applied outside the undo/history path by the caller.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { FlowGraph } from '@/lib/flows/graph'

export type JamPeer = { userId: string; name: string; selectedNodeId: string | null }

const BROADCAST_DEBOUNCE_MS = 120

export function useFlowJam(options: {
  flowId: string
  userId: string | undefined
  userName: string
  selectedNodeId: string | null
  /** Apply a peer's graph (outside the undo stack; must not re-broadcast). */
  onRemoteGraph: (graph: FlowGraph) => void
  /** A peer saved: adopt their updatedAt as the new concurrency base. */
  onRemoteSaved: (updatedAt: string) => void
}) {
  const { flowId, userId, userName, selectedNodeId } = options
  const [peers, setPeers] = useState<JamPeer[]>([])
  const clientId = useMemo(() => Math.random().toString(36).slice(2), [])
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Refs so the channel subscription (created once) sees fresh callbacks.
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  useEffect(() => {
    if (!flowId || !userId) return
    const supabase = createClient()
    const channel = supabase.channel(`flow-jam:${flowId}`, {
      config: { broadcast: { self: false }, presence: { key: userId } },
    })
    channelRef.current = channel

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<{ userId: string; name: string; selectedNodeId: string | null }>()
        const next: JamPeer[] = []
        for (const entries of Object.values(state)) {
          const entry = entries[0]
          if (entry && entry.userId !== userId) {
            next.push({ userId: entry.userId, name: entry.name, selectedNodeId: entry.selectedNodeId ?? null })
          }
        }
        setPeers(next)
      })
      .on('broadcast', { event: 'graph' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return
        const graph = payload.graph as FlowGraph | undefined
        if (graph?.nodes) callbacksRef.current.onRemoteGraph(graph)
      })
      .on('broadcast', { event: 'saved' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return
        if (typeof payload.updatedAt === 'string') callbacksRef.current.onRemoteSaved(payload.updatedAt)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ userId, name: userName, selectedNodeId })
        }
      })

    return () => {
      channelRef.current = null
      void supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, userId])

  // Keep presence's selectedNodeId fresh (cheap re-track on selection change).
  useEffect(() => {
    if (!channelRef.current || !userId) return
    void channelRef.current.track({ userId, name: userName, selectedNodeId })
  }, [selectedNodeId, userId, userName])

  const broadcastGraph = (graph: FlowGraph) => {
    if (!channelRef.current) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void channelRef.current?.send({ type: 'broadcast', event: 'graph', payload: { clientId, graph } })
    }, BROADCAST_DEBOUNCE_MS)
  }

  const broadcastSaved = (updatedAt: string) => {
    void channelRef.current?.send({ type: 'broadcast', event: 'saved', payload: { clientId, updatedAt } })
  }

  return { peers, broadcastGraph, broadcastSaved }
}
