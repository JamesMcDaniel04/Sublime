'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Play, Save, Sparkles, Loader2, ListChecks, MessageSquareText, ShieldCheck, Undo2, Redo2, MoreHorizontal, Copy, Download, Trash2, FlaskConical, History, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { emptyGraph, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { insertNodeAfter, appendToBranch, duplicateNode, updateNode, deleteNode, addContainerStep, moveNodeAfter, moveContainerStep, pasteNodeAfter, addNodeAt, addConnectedNodeAt } from '@/lib/flows/mutate'
import { stackCompatible } from '@/lib/flows/stack-compat'
import { writeFlowClipboard, readFlowClipboard } from '@/lib/flows/clipboard'
import { diffFlowGraphs, patchIsEmpty, type FlowCollaborationPatch } from '@/lib/flows/collaboration'
import { applyPatchStrict, invertPatch } from '@/lib/flows/undo'
import { applyCopilotOps, type CopilotOp } from '@/lib/flows/copilot-ops'
import { remediationForFailedRun, type FlowFailureRemediation } from '@/lib/flows/failure-remediation'
import { parseFlowInput } from '@/lib/flows/input'
import { validateFlowGraph } from '@/lib/flows/validate'
import { defaultStepLabel, stepLabelsOf } from '@/lib/flows/token-text'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
import { storedRunInput, prefillTextFromRunInput } from '@/lib/flows/reuse-input'
import { FlowCanvas, type FlowInsertSeed } from '@/components/flows/flow-canvas'
import dynamic from 'next/dynamic'

// The canvas pulls in @xyflow/react + dagre (~200 kB) — by far the heaviest
// dependency of this route. Loading it lazily lets the builder shell (header,
// checker, settings panel) paint immediately while the canvas hydrates.
const DagCanvas = dynamic(() => import('@/components/flows/dag-canvas').then((m) => m.DagCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex min-w-0 flex-1 items-center justify-center bg-background">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
    </div>
  ),
})
import { ShareControl } from '@/components/share-control'
import { cn } from '@/lib/utils'
import { startCanvasPan } from '@/components/flows/canvas-pan'
import { CanvasRail } from '@/components/flows/canvas-rail'
import type { ToolCatalog } from '@/components/flows/tool-catalog-type'
import type { CopilotRequest } from '@/components/flows/copilot-panel'
import type { FlowRunDetail } from '@/components/flows/run-panel'
import { NodeDetailView, type NodeTestState } from '@/components/flows/ndv/node-detail-view'
import { downstreamWriteActions, resolveNodeTestInput, topoSortByGraph } from '@/lib/flows/node-test-input'
import { buildPreviewContext } from '@/lib/flows/preview-context'
import { ResizablePanel } from '@/components/flows/resizable-panel'
import { useFlowJam, type HuddleSignal, type JamPeer } from '@/components/flows/use-flow-jam'
import { CanvasErrorBoundary } from '@/components/flows/canvas-error-boundary'
import { useJamHuddle } from '@/components/flows/use-jam-huddle'
import { CommentsPanel, JamStackCommentPins, commentPinsFor, useFlowComments, type CommentAnchorPoint } from '@/components/flows/flow-comments'
import { contentPointFromClient, jamCursorColor, type JamCursor } from '@/lib/flows/jam-presence'
import type { ReactFlowInstance } from '@xyflow/react'
import { JamButton } from '@/components/flows/jam-button'
import type { StepStatus } from '@/components/flows/step-card'
import { SuggestedImprovementBanner } from '@/components/intelligence/suggested-improvement-banner'
import { getCachedJson, invalidateCachedJson } from '@/lib/client/use-cached-json'
import { useRunEvents } from '@/lib/client/use-run-events'

// Side panels are substantial, mutually optional surfaces. Keep them out of
// the builder's initial bundle and load each only when the user opens it.
const CopilotPanel = dynamic(() => import('@/components/flows/copilot-panel').then((m) => m.CopilotPanel), { ssr: false })
const RunPanel = dynamic(() => import('@/components/flows/run-panel').then((m) => m.RunPanel), { ssr: false })
const CheckerPanel = dynamic(() => import('@/components/flows/checker-panel').then((m) => m.CheckerPanel), { ssr: false })
const TestPanel = dynamic(() => import('@/components/flows/test-panel').then((m) => m.TestPanel), { ssr: false })
const VersionsPanel = dynamic(() => import('@/components/flows/versions-panel').then((m) => m.VersionsPanel), { ssr: false })

type Agent = { id: string; title: string }

import {
  spineIds, parentLoop, parentParallelBranch, parseFlowValue, isRecordLike,
  triggerInputFields,
  clampZoom,
} from './flow-builder-helpers'

/**
 * Peer cursors for the STACK canvas, rendered in CONTENT coordinates inside
 * the pan/zoom-transformed wrapper — each viewer's own transform projects
 * them, so a peer pointing at a card shows at that card on every screen.
 * (DAG-mode cursors render inside DagCanvas via ViewportPortal.)
 */
function JamStackCursors({ peers, zoom }: Readonly<{ peers: JamPeer[]; zoom: number }>) {
  const live = peers.filter(
    (peer): peer is JamPeer & { cursor: JamCursor } => peer.cursor?.space === 'stack',
  )
  if (live.length === 0) return null
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {live.map((peer) => (
        <div
          key={peer.clientId}
          className="absolute transition-[left,top] duration-75 ease-linear"
          // Counter-scale so the cursor stays constant screen size under zoom.
          style={{ left: peer.cursor.point.x, top: peer.cursor.point.y, transform: `scale(${1 / zoom})`, transformOrigin: 'top left' }}
        >
          <svg width="18" height="24" viewBox="0 0 18 24" className="drop-shadow" aria-hidden="true">
            <path d="M2 1L16 13H9.5L6 21L2 1Z" fill={jamCursorColor(peer.userId)} stroke="white" strokeWidth="1.5" />
          </svg>
          <span
            className="ml-3 -mt-1 block w-fit whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold text-white shadow"
            style={{ backgroundColor: jamCursorColor(peer.userId) }}
          >
            {peer.name}
          </span>
        </div>
      ))}
    </div>
  )
}

function FlowBuilder() {
  const { id } = useParams<{ id: string }>()
  const router = useScopedRouter()
  const searchParams = useSearchParams()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [graph, setGraph] = useState<FlowGraph>(emptyGraph())
  // True when the saved draft differs from the published graph (serialized by
  // the server); `dirty` covers what's on screen but not yet saved.
  const [unpublishedChanges, setUnpublishedChanges] = useState(false)
  const [version, setVersion] = useState(1)
  const [published, setPublished] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [availableFlows, setAvailableFlows] = useState<{ id: string; name: string; published: boolean }[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [fixing, setFixing] = useState(false)
  // Copilot is the workflow-building assistant — open by default so it's always
  // there; the top-bar toggle can still hide it.
  // Closed by default — the Copilot opens on the toolbar toggle or when an
  // action explicitly sends it a request (apply suggestion, fix a failed run).
  const [showCopilot, setShowCopilot] = useState(false)
  const [showRuns, setShowRuns] = useState(false)
  const [showChecker, setShowChecker] = useState(false)
  const [showTest, setShowTest] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [viewingVersion, setViewingVersion] = useState<{ version: number; graph: FlowGraph } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The Node Detail View's open node. Kept alongside selectedId (not derived
  // from it) so selecting a card on the canvas doesn't pop a full overlay.
  const [ndvNodeId, setNdvNodeId] = useState<string | null>(null)
  const openNdv = useCallback((nodeId: string) => {
    setSelectedId(nodeId)
    setNdvNodeId(nodeId)
  }, [])
  const [statusByNode, setStatusByNode] = useState<Record<string, StepStatus>>({})
  // Nodes the copilot just touched — pulsed on the canvas, cleared after 2.5s.
  const [highlightIds, setHighlightIds] = useState<string[]>([])
  const highlightTimer = useRef<number | undefined>(undefined)
  const [zoom, setZoomState] = useState(() => {
    if (typeof window === 'undefined') return 1
    const saved = Number(window.localStorage.getItem('flows.canvasZoom'))
    return saved ? clampZoom(saved) : 1
  })
  const setZoom = useCallback((value: number) => {
    const clamped = clampZoom(value)
    setZoomState(clamped)
    if (typeof window !== 'undefined') window.localStorage.setItem('flows.canvasZoom', String(clamped))
  }, [])
  const canvasScrollRef = useRef<HTMLDivElement>(null)
  // Click-and-hold pan on the empty canvas background: the drag translates
  // the canvas PLANE (a CSS translate alongside the zoom scale), so grabbing
  // the background always moves the canvas — even when nothing overflows.
  // Session logic lives in canvas-pan.ts (pure, unit-tested); after a real
  // drag the container's click is suppressed so releasing doesn't deselect.
  const [canvasPan, setCanvasPan] = useState({ x: 0, y: 0 })
  // Canvas view: the classic vertical stack, or the free-form DAG canvas (which
  // can express fan-in/fan-out the stack cannot). Both are at parity — insert
  // menus (AddStepPanel + nested container menus), jam cursors (the wrapper
  // broadcasts, the overlay renders over either canvas), and container bodies
  // (editable in the DAG settings drawer). The stack stays the default purely
  // as the familiar view; users switch per-preference.
  const [canvasMode, setCanvasModeState] = useState<'stack' | 'dag'>(() => {
    if (typeof window === 'undefined') return 'stack'
    return window.localStorage.getItem('flows.canvasMode') === 'dag' ? 'dag' : 'stack'
  })
  const setCanvasMode = useCallback((mode: 'stack' | 'dag') => {
    setCanvasModeState(mode)
    if (typeof window !== 'undefined') window.localStorage.setItem('flows.canvasMode', mode)
  }, [])
  // A non-linear graph (fan-out/fan-in) locks to the canvas: the stack's
  // single-chain walk would silently hide wires — including ones a Jam peer
  // just drew, which is why this also force-switches an open stack view.
  const stackOk = useMemo(() => stackCompatible(graph), [graph])
  useEffect(() => {
    if (!stackOk && canvasMode === 'stack') setCanvasMode('dag')
  }, [stackOk, canvasMode, setCanvasMode])
  const [snapToGrid, setSnapToGrid] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('flows.snapToGrid') === 'true'
  })
  const canvasPanRef = useRef(canvasPan)
  canvasPanRef.current = canvasPan
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const jamCursorUpdateRef = useRef<(cursor: JamCursor | null) => void>(() => {})
  // The stack canvas's pan/zoom-transformed content wrapper. Its measured rect
  // already reflects every transform, so cursor capture divides the zoom back
  // out and gets exact content coordinates.
  const stackContentRef = useRef<HTMLDivElement>(null)
  // React Flow instance (DAG mode) — follow mode drives setViewport through it.
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null)
  // Which peer's viewport we're following, if any (Figma's follow mode).
  const [followingClientId, setFollowingClientId] = useState<string | null>(null)
  const panRef = useRef<ReturnType<typeof startCanvasPan>>(null)
  // Two-finger pinch state: live touch points by pointer id, plus the distance/
  // zoom captured when the second finger lands (the pinch baseline).
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchBaseRef = useRef<{ distance: number; zoom: number } | null>(null)

  // Trackpad pinch arrives as a ctrl/cmd+wheel event. Attached natively
  // (passive: false) because React's synthetic wheel handler can't reliably
  // preventDefault, and the browser would page-zoom instead of canvas-zoom.
  useEffect(() => {
    const container = canvasScrollRef.current
    if (!container) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setFollowingClientId(null) // a manual zoom breaks follow mode
      setZoom(zoomRef.current * Math.exp(-event.deltaY * 0.01))
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [setZoom, canvasMode, loading, loadError])
  const suppressCanvasClickRef = useRef(false)
  const pinchDistance = () => {
    const points = [...touchPointsRef.current.values()]
    return points.length >= 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0
  }
  const onCanvasPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    setFollowingClientId(null) // grabbing the canvas breaks follow mode
    const container = canvasScrollRef.current
    if (!container) return
    if (event.pointerType === 'touch') {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touchPointsRef.current.size === 2) {
        // Second finger down → the gesture is a pinch, not a pan. Abandon any
        // in-flight pan session so the two inputs don't fight over the canvas.
        panRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        pinchBaseRef.current = { distance: pinchDistance(), zoom: zoomRef.current }
        container.setPointerCapture?.(event.pointerId)
        return
      }
    }
    const origin = canvasPanRef.current
    const pan = startCanvasPan(event, (dx, dy) => {
      const next = { x: origin.x + dx, y: origin.y + dy }
      setCanvasPan(snapToGrid ? { x: Math.round(next.x / 28) * 28, y: Math.round(next.y / 28) * 28 } : next)
    })
    if (!pan) return
    panRef.current = pan
    container.setPointerCapture?.(event.pointerId)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [snapToGrid])
  const onCanvasPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const base = pinchBaseRef.current
      if (base && touchPointsRef.current.size >= 2) {
        const distance = pinchDistance()
        if (base.distance > 0 && distance > 0) setZoom(base.zoom * (distance / base.distance))
        return
      }
    }
    panRef.current?.move(event.clientX, event.clientY)
    // Broadcast the cursor in CONTENT coordinates (zoom divided back out of
    // the measured rect) so peers see it at the same card, not the same pixel.
    const rect = stackContentRef.current?.getBoundingClientRect()
    if (rect) {
      jamCursorUpdateRef.current({
        space: 'stack',
        point: contentPointFromClient({ x: event.clientX, y: event.clientY }, rect, zoomRef.current),
        // null until the stack measures its cards. The DAG canvas already
        // RENDERS a projected cursor for any peer that supplies an anchor, so
        // stack→dag lights up the moment this can be filled in — see
        // nearestNodeAnchor. Anchoring needs a nodeId→{x,y} map and the stack
        // only tracks selection by id, so measuring every card (and
        // re-measuring on scroll, zoom and resize) is its own piece of work.
        anchor: null,
        viewport: {
          x: canvasPanRef.current.x,
          y: canvasPanRef.current.y,
          zoom: zoomRef.current,
          scrollTop: canvasScrollRef.current?.scrollTop ?? 0,
        },
      })
    }
  }, [setZoom])
  const onCanvasPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      touchPointsRef.current.delete(event.pointerId)
      if (touchPointsRef.current.size < 2) pinchBaseRef.current = null
    }
    const pan = panRef.current
    if (!pan) return
    panRef.current = null
    suppressCanvasClickRef.current = pan.end().dragged
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    canvasScrollRef.current?.releasePointerCapture?.(event.pointerId)
  }, [])
  const [testInput, setTestInput] = useState('')
  const [runs, setRuns] = useState<{ id: string; status: string; startedAt?: string }[]>([])
  const [selectedRun, setSelectedRun] = useState<FlowRunDetail | null>(null)
  const [copilotRequest, setCopilotRequest] = useState<CopilotRequest | null>(null)
  const surfacedFailureRunRef = useRef<string | null>(null)
  const [toolCatalog, setToolCatalog] = useState<ToolCatalog>([])
  // Serialized snapshot of the last-saved state, for the unsaved-changes dot.
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [canManageJam, setCanManageJam] = useState(false)
  // Org sharing. `canManageJam` IS the ownership predicate the API returns
  // (flow.userId === me), and only the owner may change sharing.
  const [visibility, setVisibility] = useState<string>('private')
  const [errorFlowId, setErrorFlowId] = useState('')
  const [improvementSuggestions, setImprovementSuggestions] = useState<{ id: string; title: string; content: string }[]>([])
  const [dismissingSuggestionId, setDismissingSuggestionId] = useState<string | null>(null)
  // Optimistic-concurrency base: the flow's updatedAt as of load/last save.
  const baseUpdatedAtRef = useRef<string | undefined>(undefined)
  // Flow Jam: the server is the durable sequencer; Realtime accelerates graph,
  // cursor, and selected-widget presence without becoming the source of truth.
  const remoteGraphSnapshotRef = useRef<string | null>(null)
  // Join/leave toasts, throttled per user so reconnect flaps don't spam.
  const peerToastAtRef = useRef(new Map<string, number>())
  const peerToast = useCallback((kind: 'joined' | 'left', userId: string, message: string) => {
    const key = `${kind}:${userId}`
    const now = Date.now()
    if (now - (peerToastAtRef.current.get(key) ?? 0) < 30000) return
    peerToastAtRef.current.set(key, now)
    toast(message)
  }, [])
  // ── Spec 3 social layer: comments, ephemeral reactions, spotlight ──
  const [commentsOpen, setCommentsOpen] = useState(false)
  const { comments, loading: commentsLoading, refresh: refreshComments, openThreadCount } = useFlowComments(id, !loading && !loadError)
  // Canvas-point pins: placement mode arms the next canvas click; the clicked
  // point becomes the pending anchor the panel's composer posts with.
  const [placingPin, setPlacingPin] = useState(false)
  const [pendingPin, setPendingPin] = useState<CommentAnchorPoint | null>(null)
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null)
  const placePin = useCallback((space: CommentAnchorPoint['space'], point: { x: number; y: number }) => {
    setPendingPin({ space, x: point.x, y: point.y })
    setPlacingPin(false)
    setCommentsOpen(true)
  }, [])
  const openPinThread = useCallback((rootId: string) => {
    setCommentsOpen(true)
    setFocusThreadId(rootId)
  }, [])
  useEffect(() => {
    if (!placingPin) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlacingPin(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [placingPin])
  // Safety-net poll while the panel is open: the jam channel's
  // `comments-changed` nudge is the fast path, but a degraded channel must not
  // freeze the thread list (mirrors the sync engine's poll fallback).
  useEffect(() => {
    if (!commentsOpen) return
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshComments()
    }, 30000)
    return () => window.clearInterval(timer)
  }, [commentsOpen, refreshComments])
  // Spotlight requests are consent-based and throttled — never a forced viewport.
  const spotlightToastAtRef = useRef(0)

  // Huddle signaling arrives via useFlowJam but is handled by useJamHuddle,
  // which itself needs useFlowJam's transport — a ref breaks the circle (same
  // pattern as jamCursorUpdateRef).
  const huddleSignalRef = useRef<(signal: HuddleSignal) => void>(() => {})
  const { peers, connectionState, connectionDetail, graphSyncLive, clientId, broadcastGraph, updateCursor, broadcastAccessChange, sendHuddleSignal, setHuddlePresence, requestSpotlight, broadcastCommentsChanged } = useFlowJam({
    flowId: id,
    enabled: !loading && !loadError,
    selectedNodeId: selectedId,
    onRemoteGraph: (remote) => {
      remoteGraphSnapshotRef.current = JSON.stringify(remote)
      setGraph(remote)
    },
    onRemoteSaved: (updatedAt) => {
      baseUpdatedAtRef.current = updatedAt
    },
    onConflict: (message) => toast.warning(message, { duration: 8000 }),
    onPeersChanged: ({ joined, left }) => {
      for (const peer of joined) peerToast('joined', peer.userId, `${peer.name} joined the jam`)
      for (const peer of left) peerToast('left', peer.userId, `${peer.name} left the jam`)
    },
    onHuddleSignal: (signal) => huddleSignalRef.current(signal),
    onSpotlight: ({ clientId: presenterClientId, name }) => {
      const now = Date.now()
      if (now - spotlightToastAtRef.current < 10000) return
      spotlightToastAtRef.current = now
      toast(`${name} wants everyone to follow along`, {
        duration: 10000,
        action: { label: 'Follow', onClick: () => setFollowingClientId(presenterClientId) },
      })
    },
    onCommentsChanged: () => void refreshComments(),
  })
  jamCursorUpdateRef.current = updateCursor
  const huddle = useJamHuddle({ clientId, peers, sendSignal: sendHuddleSignal, setHuddlePresence })
  huddleSignalRef.current = huddle.handleSignal

  const handleSpotlight = () => {
    requestSpotlight()
    toast.success('Asked your teammates to follow you.')
  }
  // Local mutations refresh our list AND nudge peers to refetch (offline
  // participants are notified durably by the comments API itself).
  const handleCommentsChanged = () => {
    void refreshComments()
    broadcastCommentsChanged()
  }
  // Display labels for comment anchor chips; falls back to the operator type.
  const commentNodeLabels = useMemo(() => {
    const labels: Record<string, string> = {}
    for (const node of graph.nodes) {
      labels[node.id] = (node.data as { label?: string } | undefined)?.label || node.type
    }
    return labels
  }, [graph])
  const dagCommentPins = useMemo(() => commentPinsFor(comments, 'dag'), [comments])
  const stackCommentPins = useMemo(() => commentPinsFor(comments, 'stack'), [comments])

  // Follow mode: track the followed peer's broadcast viewport (and canvas
  // mode) until the user pans/zooms themselves or clicks the avatar again.
  useEffect(() => {
    if (!followingClientId) return
    const peer = peers.find((candidate) => candidate.clientId === followingClientId)
    if (!peer) {
      setFollowingClientId(null)
      return
    }
    const cursor = peer.cursor
    if (!cursor) return
    if (cursor.space === 'dag') {
      if (canvasMode !== 'dag') setCanvasMode('dag')
      // No-op until the RF instance mounts; the next cursor tick converges.
      rfInstanceRef.current?.setViewport(
        { x: cursor.viewport.x, y: cursor.viewport.y, zoom: cursor.viewport.zoom },
        { duration: 120 },
      )
    } else {
      if (canvasMode !== 'stack') setCanvasMode('stack')
      setZoom(cursor.viewport.zoom)
      setCanvasPan({ x: cursor.viewport.x, y: cursor.viewport.y })
      if (typeof cursor.viewport.scrollTop === 'number' && canvasScrollRef.current) {
        canvasScrollRef.current.scrollTop = cursor.viewport.scrollTop
      }
    }
  }, [followingClientId, peers, canvasMode, setCanvasMode, setZoom])
  useEffect(() => {
    if (loading || loadError) return
    const snapshot = JSON.stringify(graph)
    if (remoteGraphSnapshotRef.current === snapshot) {
      remoteGraphSnapshotRef.current = null
      return
    }
    remoteGraphSnapshotRef.current = null
    broadcastGraph(graph)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, loading, loadError])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Run the user explicitly picked (dropdown or ?run= deep-link). While set,
  // the poll tick refreshes that run's details instead of stealing selection.
  const pinnedRunId = useRef<string | null>(null)
  const dirty = savedSnapshot !== '' && JSON.stringify({ name, description, graph, errorFlowId }) !== savedSnapshot

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    getCachedJson<any>('/api/flows')
      .then(async (cachedData) => {
        if (cancelled) return cachedData
        // A cached list can predate an access grant (e.g. a Jam invite deep-link
        // opened seconds after the invite): when the id is missing, re-fetch
        // fresh before concluding the user has no access.
        const inCache = cachedData?.success && Array.isArray(cachedData.flows)
          && cachedData.flows.some((f: { id: string }) => f.id === id)
        return inCache ? cachedData : getCachedJson<any>('/api/flows', 0)
      })
      .then(async (flowsData) => {
        if (cancelled) return
        if (!flowsData?.success || !Array.isArray(flowsData.flows)) throw new Error('The flow list could not be loaded.')
        const flow = (flowsData.flows || []).find((f: { id: string }) => f.id === id)
        if (!flow) throw new Error('This flow was not found or you no longer have access to it.')
        if (!flow.graph || !Array.isArray(flow.graph.nodes) || !Array.isArray(flow.graph.edges)) {
          throw new Error('This flow returned an invalid graph and was not opened to protect its saved version.')
        }
        const g = flow.graph as FlowGraph
        setName(flow.name)
        setDescription(flow.description || '')
        setGraph(g)
        setVersion(flow.version ?? 1)
        setPublished(Boolean(flow.published))
        setUnpublishedChanges(Boolean(flow.unpublishedChanges))
        setCanManageJam(Boolean(flow.canManageJam))
        setVisibility(typeof flow.visibility === 'string' ? flow.visibility : 'private')
        const loadedErrorFlowId = typeof flow.errorFlowId === 'string' ? flow.errorFlowId : ''
        setErrorFlowId(loadedErrorFlowId)
        setAvailableFlows(flowsData.flows.map((entry: { id: string; name: string; published?: boolean }) => ({ id: entry.id, name: entry.name, published: Boolean(entry.published) })))
        setSavedSnapshot(JSON.stringify({ name: flow.name, description: flow.description || '', graph: g, errorFlowId: loadedErrorFlowId }))
        baseUpdatedAtRef.current = flow.updatedAt

        // Agent choices are useful but not authoritative flow data. A failure
        // here must not turn a valid graph load into the destructive empty-canvas
        // path this guard is preventing.
        const agentsData = await getCachedJson<any>('/api/agents', 30_000).catch(() => null)
        if (!cancelled) setAgents(agentsData?.success ? agentsData.agents.map((a: Agent) => ({ id: a.id, title: a.title })) : [])
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'The flow could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    // The tool catalog loads separately — discovery can be slow and must not
    // block the canvas paint.
    fetch('/api/flows/tool-catalog', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.success) setToolCatalog(data.connections)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id, loadAttempt])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // Behavioral-intelligence Task 3: open improvement suggestions for this
  // flow, surfaced as a dismissible banner.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/flows/${id}/suggestions`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setImprovementSuggestions(data.success ? data.suggestions : [])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id])

  // One-click apply: hand the suggestion to the copilot (the same path checker
  // remediations use) and mark it accepted so the feedback loop learns.
  const applyImprovementSuggestion = (suggestion: { id: string; title: string; content: string }) => {
    if (viewingVersion) {
      toast.error('Close the version view before applying a suggestion.')
      return
    }
    setCopilotRequest({
      id: `improve-${suggestion.id}-${Date.now()}`,
      content: `Apply this suggested improvement to the flow: ${suggestion.title}. ${suggestion.content}`,
      applyOps: true,
    })
    setShowCopilot(true)
    setShowRuns(false)
    setShowChecker(false)
    const previousSuggestions = improvementSuggestions
    setImprovementSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id))
    // Rollback + toast on failure (mirrors dismissImprovementSuggestion): the
    // old fire-and-forget left the row 'open' server-side on a failed PATCH,
    // so an already-applied suggestion reappeared on the next load.
    void fetch(`/api/flows/${id}/suggestions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: suggestion.id, status: 'accepted' }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      })
      .catch(() => {
        setImprovementSuggestions(previousSuggestions)
        toast.error('The suggestion was handed to the copilot, but could not be marked accepted — it may reappear.')
      })
  }

  const dismissImprovementSuggestion = async (suggestionId: string) => {
    setDismissingSuggestionId(suggestionId)
    const previous = improvementSuggestions
    setImprovementSuggestions((prev) => prev.filter((s) => s.id !== suggestionId))
    try {
      const response = await fetch(`/api/flows/${id}/suggestions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: suggestionId, status: 'dismissed' }),
      })
      if (!response.ok) {
        setImprovementSuggestions(previous)
        toast.error('Could not dismiss that suggestion.')
      }
    } finally {
      setDismissingSuggestionId(null)
    }
  }

  // Input memory: prefill the test input once from the last successful run so
  // re-running never demands re-typing the same payload. Initialize-once: the
  // fetch fires once per mount, and the functional setter only fills a still-
  // empty box — anything the user already typed is never clobbered.
  const prefilledInput = useRef(false)
  useEffect(() => {
    if (prefilledInput.current) return
    prefilledInput.current = true
    fetch(`/api/flows/${id}/runs?status=succeeded&take=1`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const last = (data?.runs as { input?: unknown }[] | undefined)?.[0]
        if (!last) return
        const text = prefillTextFromRunInput(last.input)
        if (!text) return
        setTestInput((current) => (current.trim() ? current : text))
      })
      .catch(() => undefined)
  }, [id])

  // ?run=<id> deep-link (waiting-run emails/toasts land here): open the runs
  // panel and select that run once — later param changes don't re-trigger.
  const deepLinkedRun = useRef(false)
  useEffect(() => {
    if (deepLinkedRun.current) return
    const runId = searchParams.get('run')
    if (!runId) return
    deepLinkedRun.current = true
    setShowRuns(true)
    fetch(`/api/flows/${id}/runs`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!data?.runs) return
        setRuns(data.runs.map((r: { id: string; status: string; startedAt?: string }) => ({ id: r.id, status: r.status, startedAt: r.startedAt })))
        const found = (data.runs as FlowRunDetail[]).find((r) => r.id === runId)
        if (found) {
          pinnedRunId.current = found.id
          setSelectedRun(found)
        }
      })
      .catch(() => undefined)
  }, [id, searchParams])

  useEffect(() => () => window.clearTimeout(highlightTimer.current), [])

  // Import handoff: ?copilotDemo=1 (the import dialog's "Preview with sample
  // data") opens the Copilot and asks it to demo-run the freshly imported
  // flow, then walk through what to connect. Exactly-once per flow id.
  const copilotDemoRef = useRef<string | null>(null)
  useEffect(() => {
    if (searchParams.get('copilotDemo') !== '1' || copilotDemoRef.current === id) return
    copilotDemoRef.current = id
    setShowCopilot(true)
    setCopilotRequest({
      id: `import-demo-${id}`,
      content: 'This flow was just imported. Check its connections (list_flow_connections), then run a demo with sample data (demoMocksJson — mock every missing-connection step and every write step) so I can see end-to-end output. Afterwards, list exactly what to connect to make it run for real.',
      applyOps: true,
    })
  }, [id, searchParams])

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Undo/redo history over structural graph edits (not per-keystroke field
  // edits). PATCH-based, not snapshot-based: each entry is the forward patch of
  // YOUR operation plus its inverse, and undo/redo apply strictly onto the
  // CURRENT graph — so ⌘Z after a teammate's concurrent edit reverts only your
  // change, never resurrects a step they deleted or clobbers their field edit.
  const undoStack = useRef<{ forward: FlowCollaborationPatch; inverse: FlowCollaborationPatch }[]>([])
  const redoStack = useRef<{ forward: FlowCollaborationPatch; inverse: FlowCollaborationPatch }[]>([])
  const undoSeq = useRef(0)
  const commitGraph = useCallback(
    (next: FlowGraph) => {
      if (next === graph) return
      const seq = ++undoSeq.current
      const forward = diffFlowGraphs(graph, next, `local:${seq}`)
      setGraph(next)
      if (patchIsEmpty(forward)) return
      undoStack.current.push({ forward, inverse: invertPatch(forward, `local:${seq}:inverse`) })
      if (undoStack.current.length > 50) undoStack.current.shift()
      redoStack.current = []
    },
    [graph],
  )
  const undo = useCallback(() => {
    const entry = undoStack.current.pop()
    if (!entry) return
    const { graph: next, skipped } = applyPatchStrict(graph, entry.inverse)
    redoStack.current.push(entry)
    setGraph(next)
    setSelectedId(null)
    if (skipped.length > 0) toast('Some changes were kept — a teammate edited them after you.')
  }, [graph])
  const redo = useCallback(() => {
    const entry = redoStack.current.pop()
    if (!entry) return
    const { graph: next, skipped } = applyPatchStrict(graph, entry.forward)
    undoStack.current.push(entry)
    setGraph(next)
    setSelectedId(null)
    if (skipped.length > 0) toast('Some changes could not be redone — a teammate edited them.')
  }, [graph])
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a.title])), [agents])
  // Friendly labels for {{token}} chips in the drawer's editors and for the
  // humanized read-only summaries on canvas step cards. Version view labels
  // from the viewed snapshot so deleted/renamed steps read as they did then.
  const labelCtx = useMemo(
    () => ({ stepLabels: stepLabelsOf(viewingVersion ? viewingVersion.graph : graph, agents) }),
    [graph, agents, viewingVersion],
  )
  const labelForNode = useCallback(
    (nodeId: string) => {
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (!node) return nodeId
      if (node.type === 'agent') return node.data.label || agentsById.get(node.data.agentId) || 'Agent step'
      return ('label' in node.data && node.data.label) || defaultStepLabel(node)
    },
    [graph, agentsById],
  )
  const jumpToNode = useCallback((nodeId: string) => {
    if (viewingVersion) return
    setSelectedId(nodeId)
    document.querySelector(`[data-node-id="${nodeId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [viewingVersion])
  const inputFields = useMemo(() => triggerInputFields(graph), [graph])

  // Shortcuts follow the OPEN node: a click opens the config surface directly,
  // so there is no selected-but-unopened state left for them to act on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      // isContentEditable covers the TokenTextEditor chip fields (tagName DIV):
      // without it, Backspace inside a chip editor would delete the whole step.
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return
      const openNode = ndvNodeId ? graph.nodes.find((node) => node.id === ndvNodeId) ?? null : null
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (viewingVersion) return
        if (openNode && openNode.id !== 'trigger') {
          e.preventDefault()
          commitGraph(deleteNode(graph, openNode.id))
          setNdvNodeId(null)
          toast.success('Step deleted — ⌘Z to undo.')
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        if (openNode && openNode.type !== 'trigger') {
          e.preventDefault()
          writeFlowClipboard(openNode)
          toast.success('Step copied.')
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        if (viewingVersion) return
        const copied = readFlowClipboard()
        if (!copied) return
        e.preventDefault()
        const ids = spineIds(graph)
        const afterId = openNode && openNode.id !== 'trigger' ? openNode.id : ids[ids.length - 1] ?? 'trigger'
        const { graph: next, nodeId } = pasteNodeAfter(graph, afterId, copied)
        commitGraph(next)
        openNdv(nodeId)
        toast.success('Step pasted.')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, ndvNodeId, graph, commitGraph, viewingVersion, openNdv])

  const loopContext = useMemo(() => parentLoop(graph, selectedId), [graph, selectedId])
  const parallelContext = useMemo(() => parentParallelBranch(graph, selectedId), [graph, selectedId])
  const upstreamIds = useMemo(() => {
    const ids = spineIds(graph)
    if (loopContext) {
      const loopIdx = ids.indexOf(loopContext.loop.id)
      return [
        ...(loopIdx > 0 ? ids.slice(1, loopIdx) : []),
        ...loopContext.loop.data.body.slice(0, loopContext.index),
      ].filter((x) => x !== selectedId)
    }
    if (parallelContext) {
      const parallelIdx = ids.indexOf(parallelContext.parallelId)
      return [
        ...(parallelIdx > 0 ? ids.slice(1, parallelIdx) : []),
        ...parallelContext.branch.slice(0, parallelContext.index),
      ].filter((x) => x !== selectedId)
    }
    const idx = ids.indexOf(selectedId ?? '')
    return (idx > 0 ? ids.slice(1, idx) : ids.slice(1)).filter((x) => x !== selectedId)
  }, [graph, selectedId, loopContext, parallelContext])

  // Variables initialized upstream of the selected step: fed to the datatree
  // (as {{var.<name>}} roots) and to the editors' variable-name selects.
  const upstreamVariables = useMemo(() => {
    const byName = new Map<string, string>()
    for (const uid of upstreamIds) {
      const n = graph.nodes.find((x) => x.id === uid)
      if (n?.type === 'variable' && n.data.op === 'initialize' && n.data.name.trim()) {
        byName.set(n.data.name.trim(), n.data.varType ?? 'string')
      }
    }
    return Array.from(byName, ([name, type]) => ({ name, type }))
  }, [graph, upstreamIds])

  // ── Node Detail View wiring ────────────────────────────────────────────────
  const ndvNode = useMemo(
    () => (ndvNodeId ? graph.nodes.find((node) => node.id === ndvNodeId) ?? null : null),
    [ndvNodeId, graph],
  )
  // Per-user pinned outputs — dev-time fixtures single-node tests resolve
  // input from. Loaded once per flow; mutated optimistically on pin/unpin.
  const [pins, setPins] = useState<Record<string, unknown>>({})
  useEffect(() => {
    let cancelled = false
    fetch(`/api/flows/${id}/pins`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled || !body?.pins) return
        setPins(Object.fromEntries(body.pins.map((pin: { nodeId: string; output: unknown }) => [pin.nodeId, pin.output])))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [id])
  const [nodeTestState, setNodeTestState] = useState<NodeTestState>({ status: 'idle' })
  // Reset per node — a failure banner from one step must not haunt another.
  useEffect(() => { setNodeTestState({ status: 'idle' }) }, [ndvNodeId])
  const [nodeTestOutput, setNodeTestOutput] = useState<Record<string, unknown>>({})
  // This node's output for the NDV's output pane: a pin wins (it is what a
  // test will actually use), then a fresh node-test result, then the selected
  // run's step output.
  const ndvLastOutput = useMemo(() => {
    if (!ndvNodeId) return undefined
    if (ndvNodeId in pins) return pins[ndvNodeId]
    if (ndvNodeId in nodeTestOutput) return nodeTestOutput[ndvNodeId]
    const step = selectedRun?.steps?.find((entry) => entry.nodeId === ndvNodeId)
    return step?.output === undefined || step.output === null ? undefined : parseFlowValue(step.output)
  }, [ndvNodeId, pins, nodeTestOutput, selectedRun])
  // Upstream outputs by node id — what resolveNodeTestInput falls back to when
  // nothing is pinned. Node-test results count: testing A then B chains.
  const ndvLastOutputs = useMemo(() => {
    const outputs: Record<string, unknown> = {}
    for (const step of selectedRun?.steps ?? []) {
      if (step.output !== undefined && step.output !== null) outputs[step.nodeId] = parseFlowValue(step.output)
    }
    return { ...outputs, ...nodeTestOutput }
  }, [selectedRun, nodeTestOutput])
  // Sample data for token previews — the same values the datatree offers, so
  // what you can insert is exactly what you can preview.
  //
  // `variables` is deliberately absent: upstreamVariables carries DECLARED
  // names and types, never values — a variable's value only exists mid-run. So
  // `{{var.x}}` previews as "no sample data", which is the truth. Inventing a
  // placeholder would render a fake value in the exact place the user is
  // deciding whether their mapping is right.
  const previewContext = useMemo(
    () => buildPreviewContext({
      lastOutputs: ndvLastOutputs,
      triggerInput: testInput.trim() ? parseFlowInput(testInput) : storedRunInput(selectedRun?.input),
      ...(loopContext ? { item: ndvLastOutputs.__item, loop: { index: 0, count: 1 } } : {}),
    }),
    [ndvLastOutputs, testInput, selectedRun, loopContext],
  )

  const ndvResolved = useMemo(() => {
    if (!ndvNodeId) return null
    return resolveNodeTestInput({ nodeId: ndvNodeId, graph, pins, lastOutputs: ndvLastOutputs })
  }, [ndvNodeId, graph, pins, ndvLastOutputs])
  const ndvDownstreamWrites = useMemo(
    () => (ndvNodeId ? downstreamWriteActions({ nodeId: ndvNodeId, graph }) : []),
    [ndvNodeId, graph],
  )

  /** POST one node to /test-node; returns its outcome or throws on route errors. */
  const postTestNode = useCallback(async (nodeId: string, mockOutputs: Record<string, unknown>) => {
    const response = await fetch(`/api/flows/${id}/test-node`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId, input: testInput.trim() ? parseFlowInput(testInput) : {}, mockOutputs }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Step test failed.')
    return {
      output: body.run?.output as unknown,
      error: body.run?.status === 'failed' ? String(body.run?.error || 'Step test failed.') : undefined,
      // Code steps: captured print()/console.log() lines — shown win or lose,
      // since a failure's logs are precisely the ones worth reading.
      logs: Array.isArray(body.run?.logs) ? (body.run.logs as string[]) : undefined,
    }
  }, [id, testInput])

  // Test exactly the open node. Missing ancestors are materialised first, in
  // dependency order, through the SAME single-node route — never a full run,
  // so nothing outside the ancestor set ever executes. The NDV has already
  // confirmed with the user when any of them perform writes.
  const testNode = useCallback(async () => {
    if (!ndvNodeId || !ndvResolved) return
    setNodeTestState({ status: 'running' })
    try {
      const accumulated = { ...ndvResolved.mockOutputs }
      for (const ref of topoSortByGraph(ndvResolved.missing, graph)) {
        const ancestor = await postTestNode(ref.id, accumulated)
        if (ancestor.error) throw new Error(ancestor.error)
        accumulated[ref.id] = ancestor.output
      }
      const result = await postTestNode(ndvNodeId, accumulated)
      if (result.error) {
        setNodeTestState({ status: 'failed', error: result.error, logs: result.logs })
        return
      }
      setNodeTestOutput((previous) => ({ ...previous, ...accumulated, [ndvNodeId]: result.output }))
      setNodeTestState({ status: 'succeeded', logs: result.logs })
    } catch (error) {
      setNodeTestState({ status: 'failed', error: error instanceof Error ? error.message : 'Step test failed.' })
    }
  }, [ndvNodeId, ndvResolved, graph, postTestNode])

  const pinNode = useCallback(async () => {
    if (!ndvNodeId || ndvLastOutput === undefined) return
    setPins((previous) => ({ ...previous, [ndvNodeId]: ndvLastOutput }))
    await fetch(`/api/flows/${id}/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: ndvNodeId, output: ndvLastOutput }),
    }).catch(() => {})
  }, [id, ndvNodeId, ndvLastOutput])

  const unpinNode = useCallback(async () => {
    if (!ndvNodeId) return
    setPins((previous) => {
      const next = { ...previous }
      delete next[ndvNodeId]
      return next
    })
    await fetch(`/api/flows/${id}/pins`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: ndvNodeId }),
    }).catch(() => {})
  }, [id, ndvNodeId])
  // `?node=<id>` keeps the open NDV in the URL — a builder link can point at a
  // specific step, and a refresh mid-configuration doesn't dump you back to
  // the bare canvas. replaceState, not router.push: opening/closing an overlay
  // must not grow the back stack.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (ndvNodeId) params.set('node', ndvNodeId)
    else params.delete('node')
    const next = params.toString()
    window.history.replaceState(null, '', next ? `?${next}` : window.location.pathname)
  }, [ndvNodeId])
  // Adopt an incoming `?node=` once, after the graph has loaded — and only if
  // the id still exists (a stale link must not open an empty NDV).
  const ndvUrlAdopted = useRef(false)
  useEffect(() => {
    if (ndvUrlAdopted.current || graph.nodes.length === 0) return
    ndvUrlAdopted.current = true
    const initial = new URLSearchParams(window.location.search).get('node')
    if (initial && graph.nodes.some((node) => node.id === initial)) openNdv(initial)
  }, [graph, openNdv])

  const validation = useMemo(
    () => validateFlowGraph(graph, { agents, toolCatalog }),
    [graph, agents, toolCatalog],
  )

  const issuesByNode = useMemo(() => {
    const map: Record<string, { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }> = {}
    for (const issue of validation.issues) {
      if (!issue.nodeId) continue
      const entry = (map[issue.nodeId] ??= { errors: 0, warnings: 0, items: [] })
      if (issue.level === 'error') entry.errors += 1
      else entry.warnings += 1
      entry.items.push({ level: issue.level, message: issue.message })
    }
    return map
  }, [validation])

  const runtimeRemediation = useMemo(
    () => remediationForFailedRun(selectedRun),
    [selectedRun],
  )

  useEffect(() => {
    if (!selectedRun || !runtimeRemediation || surfacedFailureRunRef.current === selectedRun.id) return
    surfacedFailureRunRef.current = selectedRun.id
    // A failed run should immediately expose a useful diagnosis instead of a
    // red status with no next step. The user still chooses whether Copilot may
    // apply a safe fix.
    setShowChecker(true)
  }, [selectedRun, runtimeRemediation])

  const remediateFailure = useCallback((remediation: FlowFailureRemediation) => {
    if (viewingVersion && remediation.kind !== 'user_action') {
      toast.error('Close the version view before applying a runtime fix.')
      return
    }
    setCopilotRequest({
      id: `${selectedRun?.id ?? 'failed-run'}-${Date.now()}`,
      content: remediation.copilotPrompt,
      applyOps: remediation.kind !== 'user_action',
    })
    setShowCopilot(true)
    setShowRuns(false)
    setShowChecker(false)
  }, [selectedRun, viewingVersion])

  const save = useCallback(async (): Promise<boolean> => {
    if (loadError || savedSnapshot === '') {
      toast.error('This flow has not loaded successfully, so Save is disabled to protect the existing graph.')
      return false
    }
    setSaving(true)
    try {
      // While the jam is durably persisting the graph (patch-sequenced by the
      // collaboration endpoint), Save must NOT send its whole-graph overwrite:
      // the jam keeps baseUpdatedAt fresh, so the optimistic-concurrency check
      // would pass while this client's graph copy may lack teammates' latest
      // work — a wholesale PUT then clobbers (or blanks) the shared flow.
      // Metadata still saves; the graph is already saved, patch by patch.
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, description, ...(graphSyncLive ? {} : { graph }), errorFlowId: errorFlowId || null, baseUpdatedAt: baseUpdatedAtRef.current }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not save the flow.', response.status === 409 ? { duration: 10000 } : undefined)
        return false
      }
      if (data.flow?.updatedAt) {
        baseUpdatedAtRef.current = data.flow.updatedAt
      }
      invalidateCachedJson('/api/flows')
      setSavedSnapshot(JSON.stringify({ name, description, graph, errorFlowId }))
      if (data.flow) setUnpublishedChanges(Boolean(data.flow.unpublishedChanges))
      return true
    } finally {
      setSaving(false)
    }
  }, [id, name, description, graph, errorFlowId, loadError, savedSnapshot, graphSyncLive])

  const publish = useCallback(
    async (revert = false) => {
      setPublishing(true)
      try {
        if (!revert && !validation.ok) {
          toast.error(validation.errors[0]?.message || 'Fix the flow before publishing.')
          return
        }
        if (!revert && !(await save())) return
        const response = await fetch(`/api/flows/${id}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revert }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          toast.error(data.error || 'Could not publish.')
          return
        }
        if (revert && data.flow?.graph) {
          // The server revert bumps updatedAt — refresh the optimistic-
          // concurrency base and the dirty-tracking snapshot (same as
          // restoreVersion) or the next Save 409s forever.
          if (data.flow.updatedAt) baseUpdatedAtRef.current = data.flow.updatedAt
          setGraph(data.flow.graph)
          setSavedSnapshot(JSON.stringify({ name, description, graph: data.flow.graph, errorFlowId }))
        }
        setVersion(data.flow?.version ?? version)
        setPublished(Boolean(data.flow?.published))
        setUnpublishedChanges(Boolean(data.flow?.unpublishedChanges))
        toast.success(revert ? 'Reverted to the published version.' : 'Published — this version is now live.')
      } finally {
        setPublishing(false)
      }
    },
    [id, save, validation, version, name, description, errorFlowId],
  )

  const unpublish = useCallback(async () => {
    if (!window.confirm('Unpublish this flow? Scheduled runs and webhook triggers stop firing, and any agent wired to call it loses the tool. Your draft and version history are kept.')) return
    setPublishing(true)
    try {
      const response = await fetch(`/api/flows/${id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unpublish: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not unpublish.')
        return
      }
      setPublished(Boolean(data.flow?.published))
      setUnpublishedChanges(Boolean(data.flow?.unpublishedChanges))
      toast.success('Unpublished — triggers and agent calls are stopped.')
    } finally {
      setPublishing(false)
    }
  }, [id])

  const pollRuns = useCallback(() => {
    const tick = async () => {
      const data = await fetch(`/api/flows/${id}/runs`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      const allRuns = data?.runs as FlowRunDetail[] | undefined
      if (allRuns) setRuns(allRuns.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt })))
      const latest = data?.latest as FlowRunDetail | null
      if (!latest) return
      // Respect a pinned run: refresh its details (so a waiting banner clears
      // when it resumes) instead of stealing selection back to the latest run.
      const pinned = pinnedRunId.current && pinnedRunId.current !== latest.id
        ? allRuns?.find((r) => r.id === pinnedRunId.current) ?? null
        : null
      const target = pinned ?? latest
      setSelectedRun(target)
      const map: Record<string, StepStatus> = {}
      for (const step of target.steps as { nodeId: string; status: StepStatus }[]) map[step.nodeId] = step.status
      setStatusByNode(map)
      const done = (r: FlowRunDetail) => ['succeeded', 'failed'].includes(r.status)
      if (done(latest) && (!pinned || done(pinned)) && pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    // Backoff by poll age: 2s while fresh, 5s after a minute, 15s after five.
    // A run sitting in a deep queue backlog previously generated a 2s poll for
    // its entire wait (~900 requests per queued run) with a full-payload
    // response each time.
    const intervalFor = (elapsedMs: number) => {
      if (elapsedMs < 60_000) return 2_000
      if (elapsedMs < 300_000) return 5_000
      return 15_000
    }
    const startedPolling = Date.now()
    const schedule = () => {
      pollRef.current = window.setTimeout(async () => {
        await tick()
        // tick() nulls pollRef when the run is terminal — stop rescheduling.
        if (pollRef.current !== null) schedule()
      }, intervalFor(Date.now() - startedPolling)) as unknown as ReturnType<typeof setInterval>
    }
    if (pollRef.current) clearInterval(pollRef.current)
    schedule()
    tick()
  }, [id])

  // Push half of run delivery: an org run-event means "check now" — restart
  // the poll loop immediately (which also resets its backoff to the fresh 2s
  // cadence) instead of waiting out the current interval. Polling remains the
  // authoritative fallback; without Supabase env this is simply inert.
  useRunEvents(pollRuns)

  // Re-attach to a background run when the builder (re)mounts. A run started
  // here keeps executing server-side regardless of this page's lifetime, so
  // navigating away and back must reconnect the UI to it rather than show an
  // empty panel: load recent runs so history is visible immediately, and if the
  // latest run is still in flight, reopen the run panel and resume live polling.
  // Runs once per mount; a `?run=` deep-link owns selection when present.
  const reattachedRun = useRef(false)
  useEffect(() => {
    if (reattachedRun.current) return
    reattachedRun.current = true
    fetch(`/api/flows/${id}/runs?take=20`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!data?.runs) return
        setRuns((data.runs as FlowRunDetail[]).map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt })))
        const latest = data.latest as FlowRunDetail | null
        if (latest && (['queued', 'claimed', 'running', 'waiting'].includes(latest.status)) && !searchParams.get('run')) {
          setShowRuns(true)
          pollRuns()
        }
      })
      .catch(() => undefined)
  }, [id, searchParams, pollRuns])

  const selectRun = useCallback(
    async (runId: string) => {
      pinnedRunId.current = runId
      const data = await fetch(`/api/flows/${id}/runs`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      const found = (data?.runs as FlowRunDetail[] | undefined)?.find((r) => r.id === runId)
      if (found) setSelectedRun(found)
    },
    [id],
  )

  // Answer a paused run's agent question — the execute route resumes it.
  const replyToRun = useCallback(
    async (flowRunId: string, reply: string) => {
      const response = await fetch(`/api/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowRunId, reply }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error ?? 'Could not send the reply.')
        // Re-throw so the panel keeps the typed reply for a retry.
        throw new Error(data.error ?? 'Could not send the reply.')
      }
      toast.success('Reply sent — resuming the flow.')
      pollRuns()
    },
    [id, pollRuns],
  )

  // Stop a live run: immediate for waiting runs (no executor attached),
  // cooperative for running ones (the executor stops at the next node boundary).
  const stopRun = useCallback(
    async (runId: string) => {
      const response = await fetch(`/api/flows/${id}/runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) toast.error(data.error || 'Could not stop the run.')
      else toast.success(data.status === 'stopped' ? 'Run stopped.' : 'Stopping — the current step finishes first.')
      pollRuns()
      void selectRun(runId)
    },
    [id, pollRuns, selectRun],
  )

  // Re-run a settled run with its original input (server keeps the input, so
  // this works even when the trigger payload came from a webhook or schedule).
  const resubmitRun = useCallback(
    async (runId: string) => {
      const response = await fetch(`/api/flows/${id}/runs/${runId}/resubmit`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not re-run this run.')
        return
      }
      toast.success('Re-run started with the original input.')
      if (data.run?.flowRunId) pinnedRunId.current = data.run.flowRunId
      setShowRuns(true)
      pollRuns()
    },
    [id, pollRuns],
  )

  const viewVersion = useCallback(
    async (v: number) => {
      const data = await fetch(`/api/flows/${id}/versions?version=${v}`, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
      if (data?.success && data.version?.graph) {
        setSelectedId(null)
        setViewingVersion({ version: v, graph: data.version.graph })
      } else {
        toast.error('Could not load that version.')
      }
    },
    [id],
  )

  const restoreVersion = useCallback(
    async (v: number) => {
      const response = await fetch(`/api/flows/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: v, action: 'restore' }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.flow?.graph) {
        if (data.flow.updatedAt) baseUpdatedAtRef.current = data.flow.updatedAt
        commitGraph(data.flow.graph)
        setSavedSnapshot(JSON.stringify({ name, description, graph: data.flow.graph, errorFlowId }))
        setViewingVersion(null)
        toast.success(`Restored v${v} into the draft.`)
      } else {
        toast.error(data.error || 'Could not restore that version.')
      }
    },
    [id, commitGraph, name, description, errorFlowId],
  )

  const run = useCallback(async (options?: { startNodeId?: string; mockOutputsText?: string }) => {
    if (viewingVersion) {
      toast.error('Close the version view before running.')
      return
    }
    if (!validation.ok) {
      toast.error(validation.errors[0]?.message || 'Fix the flow before running.')
      return
    }
    const missing = missingRequiredInputFields(inputFields, parseFlowInput(testInput))
    if (missing.length) {
      toast.error(`Fill the required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
      setShowTest(true)
      return
    }
    setRunning(true)
    setShowRuns(true)
    setStatusByNode({})
    // A fresh run should be followed — drop any pin on an older run.
    pinnedRunId.current = null
    try {
      if (!(await save())) return
      pollRuns()
      let mockOutputs: Record<string, unknown> | undefined
      if (options?.mockOutputsText?.trim()) {
        try {
          const parsed = JSON.parse(options.mockOutputsText)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
          mockOutputs = parsed
        } catch {
          toast.error('Mock upstream outputs must be a JSON object keyed by step id.')
          return
        }
      }
      const response = await fetch(`/api/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: testInput, startNodeId: options?.startNodeId, mockOutputs }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) toast.error(data.error || 'Run failed.')
      else if (data.run?.status === 'waiting') toast('The flow is waiting for your reply.', { action: { label: 'View', onClick: () => setShowRuns(true) } })
      else if (data.run?.status === 'failed') {
        toast.error('The flow failed — Checker is reviewing the failure.')
        setShowChecker(true)
      }
      // A fresh run now dispatches in the background and returns before it
      // finishes (status 'queued'/'running') — the run panel tracks it to
      // completion, and it keeps going if you navigate away.
      else if (['queued', 'claimed', 'running'].includes(data.run?.status)) toast.success('Flow started — running in the background.')
      else toast.success('Flow ran.')
      pollRuns()
    } finally {
      setRunning(false)
    }
  }, [id, save, pollRuns, testInput, validation, inputFields, viewingVersion])

  // Today's startNodeId behaviour, newly explicit: this node AND downstream.
  const runFromHere = useCallback(() => {
    if (!ndvNodeId || !ndvResolved) return
    setNdvNodeId(null)
    void run({ startNodeId: ndvNodeId, mockOutputsText: JSON.stringify(ndvResolved.mockOutputs) })
  }, [ndvNodeId, ndvResolved, run])

  const fixWithCopilot = useCallback(async () => {
    if (viewingVersion) {
      toast.error('Close the version view before applying fixes.')
      return
    }
    setFixing(true)
    try {
      const response = await fetch('/api/flows/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'Fix the validation problems in this flow.',
          currentGraph: graph,
          issues: [...validation.errors, ...validation.warnings].map((issue) => issue.message),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.success && data.graph) {
        commitGraph(data.graph)
        setSelectedId(null)
        const remainingErrors = data.validation?.errors?.length ?? 0
        if (remainingErrors) {
          toast.warning(`Copilot applied fixes — ${remainingErrors} check${remainingErrors === 1 ? '' : 's'} still need attention.`)
        } else {
          toast.success('Copilot applied fixes — review the changes.')
        }
      } else {
        toast.error(data.error || 'Could not fix the flow.')
      }
    } finally {
      setFixing(false)
    }
  }, [graph, validation, commitGraph, viewingVersion])

  const onCopilotOps = useCallback(
    (ops: CopilotOp[]) => {
      if (viewingVersion) {
        toast.error('Close the version view before applying copilot changes.')
        return { applied: 0, skipped: ops.map(() => ({ reason: 'read-only version view' })) }
      }
      const result = applyCopilotOps(graph, ops)
      if (result.applied > 0) {
        commitGraph(result.graph)
        setSelectedId(null)
        setHighlightIds(result.touchedIds)
        window.clearTimeout(highlightTimer.current)
        highlightTimer.current = window.setTimeout(() => setHighlightIds([]), 2500)
      }
      return { applied: result.applied, skipped: result.skipped.map((s) => ({ reason: s.reason })) }
    },
    [viewingVersion, graph, commitGraph],
  )

  const duplicateFlow = useCallback(async () => {
    const flowName = name.trim() || 'Untitled flow'
    const response = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${flowName} copy`,
        description,
        graph,
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data.flow?.id) {
      invalidateCachedJson('/api/flows')
      toast.success('Flow duplicated.')
      router.push(`/flows/${data.flow.id}`)
    } else {
      toast.error(data.error || 'Could not duplicate the flow.')
    }
  }, [name, description, graph, router])

  /**
   * Export this workflow for another platform. The server does the conversion
   * and streams a file back, so this just follows the download. Every export
   * is sanitized server-side — credentials never leave the platform.
   */
  const exportFlow = useCallback(
    async (target: 'portable' | 'n8n' | 'workato' | 'power-automate' | 'instructions') => {
      try {
        const response = await fetch(`/api/flows/${id}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || 'Export failed')
        }
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        // Honour the filename the server chose (slugified flow name + target).
        link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'workflow'
        link.click()
        URL.revokeObjectURL(url)
        toast.success(
          target === 'instructions'
            ? 'Rebuild instructions downloaded — paste them into any builder.'
            : 'Exported. Credentials are never included — the file lists what to reconnect.',
        )
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Export failed')
      }
    },
    [id],
  )

  // Download goes through the server export rather than serializing client
  // state: the portable serializer is where credential redaction lives, and a
  // client-side JSON.stringify of the raw graph would bypass all of it.
  const downloadFlow = useCallback(() => exportFlow('portable'), [exportFlow])

  const deleteFlow = useCallback(async () => {
    const flowName = name.trim() || 'this flow'
    if (!window.confirm(`Delete "${flowName}"? This cannot be undone.`)) return
    const response = await fetch('/api/flows', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok) {
      invalidateCachedJson('/api/flows')
      toast.success('Flow deleted.')
      router.push('/flows')
    } else {
      toast.error(data.error || 'Could not delete the flow.')
    }
  }, [id, name, router])

  const refreshAgents = useCallback(async () => {
    const data = await fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    if (data?.success) setAgents(data.agents.map((a: Agent) => ({ id: a.id, title: a.title })))
  }, [])

  const applyInsertSeed = useCallback((next: FlowGraph, nodeId: string, seed?: FlowInsertSeed): FlowGraph => {
    if (!seed) return next
    const node = next.nodes.find((entry) => entry.id === nodeId)
    if (!node) return next
    if (node.type === 'agent') {
      return updateNode(next, {
        ...node,
        data: {
          ...node.data,
          agentId: seed.agentId ?? node.data.agentId,
          ...(seed.label ? { label: seed.label } : {}),
        },
      })
    }
    if (node.type === 'tool') {
      return updateNode(next, {
        ...node,
        data: {
          ...node.data,
          connectionId: seed.connectionId ?? node.data.connectionId,
          toolName: seed.toolName ?? node.data.toolName,
          actionDescription: seed.actionDescription ?? node.data.actionDescription,
          actionInputSchema: seed.actionInputSchema ?? node.data.actionInputSchema,
          actionOutputSchema: seed.actionOutputSchema ?? node.data.actionOutputSchema,
          actionSchemaHash: seed.actionSchemaHash ?? node.data.actionSchemaHash,
          risk: seed.risk ?? node.data.risk,
          ...(seed.label ? { label: seed.label } : {}),
        },
      })
    }
    if (node.type === 'variable' && seed.variableOp) {
      // Non-initialize ops mutate a variable declared elsewhere — the default
      // varType only belongs on the declaration site.
      const varType = seed.variableOp === 'initialize' ? node.data.varType : undefined
      return updateNode(next, {
        ...node,
        data: { ...node.data, op: seed.variableOp, varType, ...(seed.label ? { label: seed.label } : {}) },
      })
    }
    if (node.type === 'data' && seed.dataOp) {
      // Ops with required list config start with one empty row so the editor
      // opens ready to fill in (mirrors condition/transform defaults).
      const extras =
        seed.dataOp === 'filterArray'
          ? { clauses: [{ left: '', op: 'contains' as const, right: '' }] }
          : seed.dataOp === 'select'
            ? { fields: [{ name: '', value: '' }] }
            : {}
      return updateNode(next, {
        ...node,
        data: { ...node.data, op: seed.dataOp, ...extras, ...(seed.label ? { label: seed.label } : {}) },
      })
    }
    // Every other step type only carries the label (picker leaves like
    // "HTTP Webhook" pre-name their node).
    if (seed.label && node.type !== 'trigger') {
      return updateNode(next, { ...node, data: { ...node.data, label: seed.label } } as FlowNode)
    }
    return next
  }, [])

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-3">
          <Skeleton className="h-8 w-64 rounded-lg" />
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="mx-auto h-96 max-w-xl rounded-xl" />
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center bg-muted/20 p-6">
        <div className="w-full max-w-lg rounded-xl border border-red-200 bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div>
              <h1 className="font-semibold">This flow did not load</h1>
              <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
              <p className="mt-2 text-sm text-muted-foreground">The canvas and save actions are locked, so the saved workflow cannot be overwritten with an empty graph.</p>
            </div>
          </div>
          <div className="mt-5 flex gap-2">
            <Button onClick={() => { invalidateCachedJson('/api/flows'); setLoadAttempt((attempt) => attempt + 1) }}>Try again</Button>
            <Button variant="outline" onClick={() => router.push('/flows')}>Back to flows</Button>
          </div>
        </div>
      </div>
    )
  }

  // While viewing a historical snapshot, the canvas renders that version's
  // graph and every mutation path is inert — the live draft (`graph` state)
  // is untouched underneath, so Save/Publish/Run still act on the real draft.
  const canvasGraph = viewingVersion ? viewingVersion.graph : graph

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-card px-3 py-2.5 sm:px-4 [&_button]:shrink-0 [&_select]:shrink-0">
        <Button variant="ghost" size="icon" onClick={() => router.push('/flows')} aria-label="Back to flows">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-40 flex-1 rounded-lg bg-transparent px-2 py-1 text-base font-semibold outline-none hover:bg-muted focus:bg-muted"
          placeholder="Untitled flow"
        />
        <Button variant="ghost" size="icon" onClick={undo} aria-label="Undo" title="Undo (⌘Z)">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={redo} aria-label="Redo" title="Redo (⌘⇧Z)">
          <Redo2 className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Flow settings" title="Flow settings">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Flow settings</DropdownMenuLabel>
            <div className="space-y-1 px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="error-flow">On failure, run</label>
              <select id="error-flow" value={errorFlowId} onChange={(event) => setErrorFlowId(event.target.value)} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs">
                <option value="">No error handler</option>
                {availableFlows.filter((entry) => entry.id !== id && entry.published).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </select>
              <p className="max-w-56 text-[11px] leading-4 text-muted-foreground">The published handler receives the failed flow, run, error, and original input after Save.</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={duplicateFlow}>
              <Copy className="h-4 w-4" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={downloadFlow}>
              <Download className="h-4 w-4" /> Download JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Take this workflow elsewhere. Every export is sanitized
                server-side — credentials never travel; the file lists what to
                reconnect on the other side. */}
            <DropdownMenuLabel>Export to another platform</DropdownMenuLabel>
            {([
              ['portable', 'Portable JSON (any platform)'],
              ['n8n', 'n8n workflow (import-ready)'],
              ['workato', 'Workato recipe (linear — merges noted)'],
              ['power-automate', 'Power Automate flow (import-ready)'],
            ] as const).map(([target, label]) => (
              <DropdownMenuItem key={target} onSelect={() => exportFlow(target)}>
                <Download className="h-4 w-4" /> {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => exportFlow('instructions')}>
              <ScrollText className="h-4 w-4" /> Rebuild instructions (Zapier &amp; anything else)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={deleteFlow} className="text-red-600 focus:text-red-700">
              <Trash2 className="h-4 w-4" /> Delete flow
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Sharing is a deliberate act, so it saves immediately rather than
            riding along with the draft — and it is owner-only (the API rejects
            anyone else, so non-owners see a read-only badge). */}
        <ShareControl
          value={visibility}
          canShare={canManageJam && !viewingVersion}
          onChange={async (next) => {
            const previous = visibility
            setVisibility(next) // optimistic — revert below if the save is rejected
            try {
              const response = await fetch('/api/flows', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, visibility: next }),
              })
              const data = await response.json().catch(() => ({}))
              if (!response.ok) throw new Error(data.error || 'Could not update sharing')
              toast.success(
                next === 'private'
                  ? 'Only you can see this flow now.'
                  : next === 'org_viewer'
                    ? 'Anyone in your workspace can now view and run this flow.'
                    : 'Anyone in your workspace can now build on this flow with you.',
              )
            } catch (error) {
              setVisibility(previous)
              toast.error(error instanceof Error ? error.message : 'Could not update sharing')
            }
          }}
        />
        {/* Stack ↔ DAG canvas. The DAG view can wire many→many (3 APIs into one
            agent); both views share insert menus, jam cursors, and container
            editing. A non-linear graph LOCKS to the canvas — the stack's
            single-chain walk would silently hide fan-out/fan-in wires. */}
        <div className="flex items-center rounded-lg border border-border p-0.5">
          {(['stack', 'dag'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={mode === 'stack' && !stackOk}
              onClick={() => setCanvasMode(mode)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                canvasMode === mode ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                mode === 'stack' && !stackOk && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
              )}
              title={
                mode === 'dag' ? 'Free-form canvas — wire multiple steps into one'
                : stackOk ? 'Classic stack view'
                : 'This flow uses multi-connections — the stack view cannot show them'
              }
            >
              {mode === 'stack' ? 'Stack' : 'Canvas'}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCommentsOpen((value) => !value)}
          aria-label={commentsOpen ? 'Close comments' : 'Open comments'}
          title="Comments"
          className={cn('transition-colors duration-150', commentsOpen && 'bg-indigo-50 text-indigo-700')}
        >
          <MessageSquareText className="h-4 w-4" />
          {openThreadCount > 0 && (
            <span className="rounded-full bg-indigo-100 px-1.5 text-[10px] font-semibold text-indigo-700">{openThreadCount}</span>
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowTest((v) => !v)}>
          <FlaskConical className="mr-1.5 h-4 w-4" /> Test
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowRuns((v) => !v)}>
          <ListChecks className="mr-1.5 h-4 w-4" /> Runs
        </Button>
        <Button variant="ghost" size="sm" onClick={() => router.push(`/flows/${id}/activity`)}>
          <ScrollText className="mr-1.5 h-4 w-4" /> Activity
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowVersions((v) => !v)}>
          <History className="mr-1.5 h-4 w-4" /> History
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowCopilot((v) => !v)}>
          <Sparkles className="mr-1.5 h-4 w-4" /> Copilot
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowChecker((v) => !v)}>
          <ShieldCheck className="mr-1.5 h-4 w-4" /> Checker
          {validation.errors.length > 0 && (
            <Badge variant="risk" className="ml-1.5">{validation.errors.length}</Badge>
          )}
          {validation.errors.length === 0 && validation.warnings.length > 0 && (
            <Badge variant="warn" className="ml-1.5">{validation.warnings.length}</Badge>
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={save} loading={saving} className="relative">
          <Save className="mr-1.5 h-4 w-4" /> Save
          {dirty && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-400" title="Unsaved changes" />}
        </Button>
        {/* Publish state machine: never published → Publish; live and current →
            Unpublish; live with newer edits (saved OR on-screen) → Publish
            changes + Revert. Version numbers live in History, not here. */}
        {!published || unpublishedChanges || dirty ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => publish(false)}
            loading={publishing}
            title={published ? 'Draft differs from the published version' : 'Not yet published'}
          >
            {published ? 'Publish changes' : 'Publish'}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void unpublish()} loading={publishing} title={`Published v${version}`}>
            Unpublish
          </Button>
        )}
        {published && (unpublishedChanges || dirty) && (
          <Button variant="ghost" size="sm" onClick={() => publish(true)} title="Discard draft changes and restore the published version">
            Revert
          </Button>
        )}
        <Button size="sm" onClick={() => void run()} disabled={running}>
          {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />} Run
        </Button>
      </div>

      {improvementSuggestions.length > 0 && (
        <div className="border-b border-border px-4 py-2">
          <SuggestedImprovementBanner
            suggestions={improvementSuggestions}
            onDismiss={dismissImprovementSuggestion}
            onApply={applyImprovementSuggestion}
            applyLabel="Apply with copilot"
            dismissingId={dismissingSuggestionId}
          />
        </div>
      )}

      {viewingVersion && (
        <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
          <span>Viewing v{viewingVersion.version} — read-only</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => restoreVersion(viewingVersion.version)}>
              Restore this version
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setViewingVersion(null)}>
              Close
            </Button>
          </div>
        </div>
      )}

      {/* Body: canvas + optional drawer + optional copilot */}
      <div className="relative flex min-h-0 flex-1">
        {/* Jam presence + huddle float over the canvas (both modes share this
            one overlay because the wrapper is position:relative). The wrapper
            is pointer-transparent so it never blocks canvas interactions. */}
        <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2">
          <div className="pointer-events-auto rounded-full border border-border bg-card/95 px-2 py-1 shadow-sm backdrop-blur">
            <JamButton
              flowId={id}
              peers={peers}
              connectionState={connectionState}
              connectionDetail={connectionDetail}
              canManage={canManageJam}
              onAccessChanged={broadcastAccessChange}
              followingClientId={followingClientId}
              onToggleFollow={(peerClientId) => setFollowingClientId((current) => (current === peerClientId ? null : peerClientId))}
              huddle={huddle}
              onSpotlight={handleSpotlight}
            />
          </div>
        </div>
        {/* DAG mode owns its own pan/zoom/background (React Flow), so it renders
            OUTSIDE the stack canvas's scroll + transform wrapper. */}
        <CanvasErrorBoundary>
        {canvasMode === 'dag' ? (
          // Cursor capture happens inside DagCanvas (it needs React Flow's
          // screenToFlowPosition); peers' cursors render there too, in flow
          // space via ViewportPortal.
          <div className="min-w-0 flex-1 bg-background">
            <DagCanvas
              onCursorMove={(cursor) => jamCursorUpdateRef.current(cursor)}
              commentPins={dagCommentPins}
              onPinClick={openPinThread}
              placingPin={placingPin}
              onPlacePin={(point) => placePin('dag', point)}
              onRfInit={(instance) => {
                rfInstanceRef.current = instance
              }}
              onUserPan={() => setFollowingClientId(null)}
              graph={canvasGraph}
              agents={agents}
              toolCatalog={toolCatalog}
              statusByNode={viewingVersion ? {} : statusByNode}
              issuesByNode={viewingVersion ? undefined : issuesByNode}
              highlightIds={viewingVersion ? [] : highlightIds}
              jamPeers={peers}
              selectedId={selectedId}
              readOnly={Boolean(viewingVersion)}
              labelOf={(node) => labelCtx.stepLabels[node.id] || defaultStepLabel(node)}
              onSelect={viewingVersion ? () => {} : setSelectedId}
              onOpenNode={viewingVersion ? undefined : openNdv}
              onChangeGraph={viewingVersion ? () => {} : commitGraph}
              onAddNode={
                viewingVersion
                  ? () => {}
                  : (type, seed, position, connectFrom, connectBranch) => {
                      // Same seed handling as the stack's insert path, minus the
                      // chain splice — on the canvas the user wires it up. The
                      // quick-add gestures pass connectFrom (and, for branch
                      // nodes, the chosen output) so the new step arrives
                      // already wired from its source.
                      const agentId = type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined
                      const { graph: added, nodeId } = connectFrom
                        ? addConnectedNodeAt(graph, connectFrom, type, position, agentId, connectBranch)
                        : addNodeAt(graph, type, position, agentId)
                      commitGraph(applyInsertSeed(added, nodeId, seed))
                      setSelectedId(nodeId)
                    }
              }
            />
          </div>
        ) : (
        <div
          ref={canvasScrollRef}
          className={cn('min-w-0 flex-1 overflow-y-auto bg-background p-8', placingPin ? 'cursor-crosshair' : 'cursor-grab')}
          onClick={(event) => {
            // A completed drag-to-scroll must not read as a background click.
            if (suppressCanvasClickRef.current) {
              suppressCanvasClickRef.current = false
              return
            }
            // Placement mode: the click drops a comment pin in CONTENT
            // coordinates (same capture as the Jam cursor broadcast).
            if (placingPin) {
              const rect = stackContentRef.current?.getBoundingClientRect()
              if (rect) {
                placePin('stack', contentPointFromClient({ x: event.clientX, y: event.clientY }, rect, zoom))
                return
              }
            }
            setSelectedId(null)
          }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerLeave={() => jamCursorUpdateRef.current(null)}
          onPointerUp={onCanvasPointerEnd}
          onPointerCancel={onCanvasPointerEnd}
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(15, 23, 42, 0.22) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
            // Keep one-finger scrolling, but claim two-finger pinch for the
            // canvas zoom instead of the browser's page zoom.
            touchAction: 'pan-x pan-y',
          }}
        >
          <div
            ref={stackContentRef}
            style={{
              // Translate first (screen-pixel pan), then scale (zoom). Fit resets both.
              transform: `translate(${canvasPan.x}px, ${canvasPan.y}px) scale(${zoom})`,
              transformOrigin: 'top center',
              width: `${100 / zoom}%`,
              marginLeft: `${(1 - 1 / zoom) * 50}%`,
              // Anchor for the content-space Jam cursor overlay.
              position: 'relative',
            }}
          >
            <JamStackCursors peers={peers} zoom={zoom} />
            <JamStackCommentPins pins={stackCommentPins} zoom={zoom} onPinClick={openPinThread} />
            <FlowCanvas
              graph={canvasGraph}
              agentName={(agentId) => agentsById.get(agentId) ?? ''}
              agents={agents}
              toolCatalog={toolCatalog}
              labelCtx={labelCtx}
              statusByNode={viewingVersion ? {} : statusByNode}
              issuesByNode={viewingVersion ? undefined : issuesByNode}
              highlightIds={viewingVersion ? [] : highlightIds}
              selectedId={selectedId}
              onSelect={viewingVersion ? () => {} : setSelectedId}
              onOpenNode={viewingVersion ? undefined : openNdv}
              onBackgroundClick={() => setSelectedId(null)}
              onChangeNode={viewingVersion ? () => {} : (node) => setGraph((g) => updateNode(g, node))}
              onInsertAfter={
                viewingVersion
                  ? () => {}
                  : (afterId, type, seed) => {
                      const { graph: inserted, nodeId } = insertNodeAfter(graph, afterId, type, type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined)
                      const next = applyInsertSeed(inserted, nodeId, seed)
                      commitGraph(next)
                      setSelectedId(nodeId)
                    }
              }
              onAppendBranch={
                viewingVersion
                  ? () => {}
                  : (conditionId, branch, type, seed) => {
                      const { graph: inserted, nodeId } = appendToBranch(graph, conditionId, branch, type, type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined)
                      const next = applyInsertSeed(inserted, nodeId, seed)
                      commitGraph(next)
                      setSelectedId(nodeId)
                    }
              }
              onDuplicateNode={
                viewingVersion
                  ? () => {}
                  : (nodeId) => {
                      const { graph: next, nodeId: newId } = duplicateNode(graph, nodeId)
                      commitGraph(next)
                      setSelectedId(newId)
                    }
              }
              onDeleteNode={
                viewingVersion
                  ? () => {}
                  : (nodeId) => {
                      commitGraph(deleteNode(graph, nodeId))
                      if (selectedId === nodeId) setSelectedId(null)
                    }
              }
              onPickTrigger={
                viewingVersion
                  ? () => {}
                  : (type) => {
                      const triggerNode = graph.nodes.find((n) => n.type === 'trigger')
                      if (!triggerNode || triggerNode.type !== 'trigger') return
                      const current = isRecordLike(triggerNode.data.trigger) ? triggerNode.data.trigger : {}
                      // `configured: true` dismisses the canvas "Add a trigger"
                      // picker — an explicit pick (even of Manual) is a choice.
                      commitGraph(updateNode(graph, { ...triggerNode, data: { trigger: { ...current, type, configured: true } } }))
                      setSelectedId(triggerNode.id)
                    }
              }
              onMoveAfter={viewingVersion ? () => {} : (nodeId, afterId) => commitGraph(moveNodeAfter(graph, nodeId, afterId))}
              jamPeers={peers}
              onAddContainerStep={
                viewingVersion
                  ? undefined
                  : (containerId, type, branchIndex) => {
                      const { graph: next, nodeId } = addContainerStep(graph, containerId, type, type === 'agent' ? agents[0]?.id ?? '' : undefined, branchIndex)
                      commitGraph(next)
                      setSelectedId(nodeId)
                    }
              }
              onReorderContainer={
                viewingVersion
                  ? () => {}
                  : (containerId, from, to, branchIndex) => commitGraph(moveContainerStep(graph, containerId, from, to, branchIndex))
              }
            />
          </div>
        </div>
        )}
        </CanvasErrorBoundary>

        {/* Zoom/pan rail drives the stack canvas only — React Flow ships its own. */}
        {canvasMode === 'stack' && (
        <CanvasRail
          zoom={zoom}
          onZoom={setZoom}
          onFit={() => {
            setZoom(1)
            setCanvasPan({ x: 0, y: 0 })
            canvasScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
          }}
          onAutoFormat={() => {
            setSelectedId(null)
            setZoom(1)
            setCanvasPan({ x: 0, y: 0 })
            canvasScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
            toast.success('Workflow formatted.')
          }}
          onCollapseAll={() => setSelectedId(null)}
          snapToGrid={snapToGrid}
          onToggleSnap={() => {
            setSnapToGrid((current) => {
              const next = !current
              window.localStorage.setItem('flows.snapToGrid', String(next))
              return next
            })
          }}
          nodes={canvasGraph.nodes.filter((n) => n.type !== 'trigger').map((n) => ({ id: n.id, title: labelForNode(n.id) }))}
          onJump={jumpToNode}
        />
        )}

        {/* Step configuration lives entirely inline on the step cards — the
            side drawer was removed once the cards reached full parity. */}

        {showCopilot && (
          <ResizablePanel storageKey="flow.copilotWidth" defaultWidth={420}>
            <CopilotPanel
              graph={graph}
              flowId={id}
              onOps={onCopilotOps}
              onJump={jumpToNode}
              onGraph={(next) => {
                // Read-only version viewing: never let a generated graph
                // silently replace the live draft under the read-only banner.
                if (viewingVersion) {
                  toast.error('Close the version view before generating a flow.')
                  return
                }
                commitGraph(next as FlowGraph)
                setSelectedId(null)
                // Keep Copilot open so the user can keep iterating on the draft.
              }}
              onNeedsAttention={(issues) => {
                if (issues.length) setShowChecker(true)
              }}
              request={copilotRequest}
            />
          </ResizablePanel>
        )}

        {showTest && (
          <ResizablePanel storageKey="flow.testWidth">
            <TestPanel
              fields={inputFields}
              value={testInput}
              onChange={setTestInput}
              onRun={run}
              running={running}
              steps={(selectedRun?.steps ?? []).map((s) => ({ nodeId: s.nodeId, status: s.status }))}
              labelForNode={labelForNode}
              onInspect={() => setShowRuns(true)}
              onClose={() => setShowTest(false)}
            />
          </ResizablePanel>
        )}

        {showRuns && (
          <ResizablePanel storageKey="flow.runsWidth">
            <RunPanel
              flowId={id}
              runs={runs}
              selected={selectedRun}
              onSelectRun={selectRun}
              onClose={() => setShowRuns(false)}
              labelForNode={labelForNode}
              onReply={replyToRun}
              remediation={runtimeRemediation}
              onRemediate={remediateFailure}
              onStopRun={stopRun}
              onResubmitRun={resubmitRun}
            />
          </ResizablePanel>
        )}

        {showChecker && (
          <ResizablePanel storageKey="flow.checkerWidth">
            <CheckerPanel
              validation={validation}
              fixing={fixing}
              onFixWithCopilot={fixWithCopilot}
              runtimeFailure={runtimeRemediation}
              onRemediateFailure={remediateFailure}
              onClose={() => setShowChecker(false)}
              onJump={jumpToNode}
            />
          </ResizablePanel>
        )}

        {showVersions && (
          <ResizablePanel storageKey="flow.versionsWidth">
            <VersionsPanel
              flowId={id}
              currentVersion={version}
              isOwner={canManageJam}
              onView={viewVersion}
              onRestore={restoreVersion}
              onClose={() => setShowVersions(false)}
            />
          </ResizablePanel>
        )}
      </div>
      <CommentsPanel
        flowId={id}
        open={commentsOpen}
        onClose={() => {
          setCommentsOpen(false)
          setPendingPin(null)
          setPlacingPin(false)
          setFocusThreadId(null)
        }}
        comments={comments}
        loading={commentsLoading}
        canModerate={canManageJam}
        nodeLabels={commentNodeLabels}
        selectedNodeId={selectedId}
        onJumpToNode={(nodeId) => setSelectedId(nodeId)}
        onChanged={handleCommentsChanged}
        pendingPin={pendingPin}
        onCancelPendingPin={() => setPendingPin(null)}
        placingPin={placingPin}
        onTogglePinPlacement={() => setPlacingPin((value) => !value)}
        focusThreadId={focusThreadId}
      />
      {ndvNode && !viewingVersion && (
        <NodeDetailView
          node={ndvNode}
          flowId={id}
          agents={agents}
          toolCatalog={toolCatalog}
          labelCtx={labelCtx}
          variableNames={upstreamVariables.map((variable) => variable.name)}
          previewContext={previewContext}
          lastOutput={ndvLastOutput}
          pinned={ndvNodeId ? ndvNodeId in pins : false}
          onPin={pinNode}
          onUnpin={unpinNode}
          onTestStep={() => void testNode()}
          onRunFromHere={runFromHere}
          testState={nodeTestState}
          riskyMissing={ndvResolved?.riskyMissing ?? []}
          downstreamWrites={ndvDownstreamWrites}
          onChange={(node) => setGraph((g) => updateNode(g, node))}
          onRefreshAgents={refreshAgents}
          onDeleteNode={() => {
            commitGraph(deleteNode(graph, ndvNode.id))
            setNdvNodeId(null)
            toast.success('Step deleted — ⌘Z to undo.')
          }}
          onDuplicateNode={() => {
            const { graph: next, nodeId } = duplicateNode(graph, ndvNode.id)
            commitGraph(next)
            openNdv(nodeId)
          }}
          graph={graph}
          labelOf={(node) => labelCtx.stepLabels[node.id] || defaultStepLabel(node)}
          issuesByNode={issuesByNode}
          onOpenNode={openNdv}
          onReorderContainer={(containerId, from, to, branchIndex) => commitGraph(moveContainerStep(graph, containerId, from, to, branchIndex))}
          onAddStep={(type, branchIndex) => {
            const { graph: next, nodeId } = addContainerStep(graph, ndvNode.id, type, type === 'agent' ? agents[0]?.id ?? '' : undefined, branchIndex)
            commitGraph(next)
            setSelectedId(nodeId)
          }}
          onClose={() => setNdvNodeId(null)}
        />
      )}
    </div>
  )
}

// useSearchParams needs a Suspense boundary — same pattern as the other pages.
export default function FlowBuilderPage() {
  return (
    <Suspense fallback={null}>
      <FlowBuilder />
    </Suspense>
  )
}
