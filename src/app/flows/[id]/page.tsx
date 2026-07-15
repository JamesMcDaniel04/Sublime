'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Play, Save, Sparkles, Loader2, ListChecks, ShieldCheck, Undo2, Redo2, MoreHorizontal, Copy, Download, Trash2, FlaskConical, History, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { emptyGraph, type FlowGraph, type FlowNode, type OutputField } from '@/lib/flows/graph'
import { insertNodeAfter, appendToBranch, duplicateNode, updateNode, deleteNode, changeNodeType, addContainerStep, moveNodeAfter, moveContainerStep, pasteNodeAfter, addNodeAt } from '@/lib/flows/mutate'
import { writeFlowClipboard, readFlowClipboard } from '@/lib/flows/clipboard'
import { applyCopilotOps, type CopilotOp } from '@/lib/flows/copilot-ops'
import { remediationForFailedRun, type FlowFailureRemediation } from '@/lib/flows/failure-remediation'
import { buildDataTree } from '@/lib/flows/datatree'
import { parseFlowInput } from '@/lib/flows/input'
import { httpOutputFields, outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'
import { validateFlowGraph } from '@/lib/flows/validate'
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { defaultStepLabel, stepLabelsOf } from '@/lib/flows/token-text'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
import { storedRunInput, prefillTextFromRunInput } from '@/lib/flows/reuse-input'
import { FlowCanvas, type FlowInsertSeed } from '@/components/flows/flow-canvas'
import { DagCanvas } from '@/components/flows/dag-canvas'
import { ShareControl } from '@/components/share-control'
import { cn } from '@/lib/utils'
import { startCanvasPan } from '@/components/flows/canvas-pan'
import { CanvasRail } from '@/components/flows/canvas-rail'
import type { ToolCatalog } from '@/components/flows/tool-catalog-type'
import { CopilotPanel, type CopilotRequest } from '@/components/flows/copilot-panel'
import { RunPanel, type FlowRunDetail } from '@/components/flows/run-panel'
import { CheckerPanel } from '@/components/flows/checker-panel'
import { ResizablePanel } from '@/components/flows/resizable-panel'
import { TestPanel } from '@/components/flows/test-panel'
import { VersionsPanel } from '@/components/flows/versions-panel'
import { useFlowJam, type JamPeer } from '@/components/flows/use-flow-jam'
import { JamButton } from '@/components/flows/jam-button'
import type { StepStatus } from '@/components/flows/step-card'
import { SuggestedImprovementBanner } from '@/components/intelligence/suggested-improvement-banner'
import { getCachedJson, invalidateCachedJson } from '@/lib/client/use-cached-json'

type Agent = { id: string; title: string }

/** Ordered main-chain ids from the trigger, for upstream-token help. */
function spineIds(graph: FlowGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const nextId = (node: FlowNode): string | undefined => {
    const edges = graph.edges.filter((e) => e.source === node.id)
    return (node.type === 'condition' ? edges.find((e) => e.branch === 'true') ?? edges[0] : edges[0])?.target
  }
  const ids: string[] = []
  const seen = new Set<string>()
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    ids.push(current.id)
    const next = nextId(current)
    current = next ? byId.get(next) : undefined
  }
  return ids
}

function parentLoop(graph: FlowGraph, nodeId: string | null): { loop: Extract<FlowNode, { type: 'loop' }>; index: number } | null {
  if (!nodeId) return null
  for (const node of graph.nodes) {
    if (node.type !== 'loop') continue
    const index = node.data.body.indexOf(nodeId)
    if (index >= 0) return { loop: node, index }
  }
  return null
}

function parentParallelBranch(graph: FlowGraph, nodeId: string | null): { parallelId: string; branch: string[]; index: number } | null {
  if (!nodeId) return null
  for (const node of graph.nodes) {
    if (node.type !== 'parallel') continue
    for (const branch of node.data.branches) {
      const index = branch.indexOf(nodeId)
      if (index >= 0) return { parallelId: node.id, branch, index }
    }
  }
  return null
}

function parseFlowValue(value: unknown) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function triggerInputFields(graph: FlowGraph) {
  const triggerNode = graph.nodes.find((node): node is Extract<FlowNode, { type: 'trigger' }> => node.type === 'trigger')
  return triggerInputFieldsFromTrigger(triggerNode?.data.trigger)
}

function outputFieldsForNode(node: FlowNode | undefined, toolCatalog: ToolCatalog): OutputField[] | undefined {
  if (!node) return undefined
  if (node.type === 'agent') return node.data.outputFields
  if (node.type === 'http') return node.data.outputFields?.length ? node.data.outputFields : httpOutputFields()
  if (node.type !== 'tool') return undefined
  if (node.data.outputFields?.length) return node.data.outputFields
  const tool = toolCatalog
    .find((connection) => connection.id === node.data.connectionId)
    ?.tools.find((entry) => entry.name === node.data.toolName)
  const fields = outputFieldsFromJsonSchema(tool?.outputSchema ?? node.data.actionOutputSchema)
  return fields.length ? fields : undefined
}

function previewLoopItems(value: unknown): unknown[] {
  const parsed = parseFlowValue(value)
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const key of ['items', 'records', 'results', 'data']) {
      const candidate = (parsed as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) return candidate
    }
    return []
  }
  if (typeof parsed !== 'string') return []
  const trimmed = parsed.trim()
  if (!trimmed) return []
  const lines = trimmed.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const commaParts = trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  return commaParts.length > 1 ? commaParts : [trimmed]
}

function sampleLoopItem(loop: Extract<FlowNode, { type: 'loop' }>, lastOutputs: Record<string, unknown>, testInput: string): unknown {
  const token = loop.data.over.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1]
  let value: unknown = loop.data.over
  if (token === 'trigger.input') {
    value = testInput
  } else if (token?.startsWith('step.')) {
    const [, nodeId, outputKey, ...rest] = token.split('.')
    if (outputKey === 'output') {
      value = lastOutputs[nodeId]
      for (const part of rest) {
        if (value == null || typeof value !== 'object') {
          value = undefined
          break
        }
        value = (value as Record<string, unknown>)[part]
      }
    }
  }
  return previewLoopItems(value)[0]
}

function clampZoom(value: number): number {
  return Math.min(1.5, Math.max(0.5, value))
}

function filenameSlug(value: string): string {
  return (value || 'flow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'flow'
}

function JamCursorOverlay({ peers }: { peers: JamPeer[] }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-[70]" aria-hidden="true">
      {peers.filter((peer) => peer.cursor).map((peer) => (
        <div
          key={peer.clientId}
          className="absolute transition-[left,top] duration-75 ease-linear"
          style={{ left: `${peer.cursor!.x * 100}vw`, top: `${peer.cursor!.y * 100}vh` }}
        >
          <svg width="18" height="24" viewBox="0 0 18 24" className="drop-shadow" aria-hidden="true">
            <path d="M2 1L16 13H9.5L6 21L2 1Z" fill="#4f46e5" stroke="white" strokeWidth="1.5" />
          </svg>
          <span className="ml-3 -mt-1 block whitespace-nowrap rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
            {peer.name}
          </span>
        </div>
      ))}
    </div>
  )
}

function FlowBuilder() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [graph, setGraph] = useState<FlowGraph>(emptyGraph())
  const [status, setStatus] = useState('draft')
  const [version, setVersion] = useState(1)
  const [published, setPublished] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [fixing, setFixing] = useState(false)
  // Copilot is the workflow-building assistant — open by default so it's always
  // there; the top-bar toggle can still hide it.
  const [showCopilot, setShowCopilot] = useState(true)
  const [showRuns, setShowRuns] = useState(false)
  const [showChecker, setShowChecker] = useState(false)
  const [showTest, setShowTest] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [viewingVersion, setViewingVersion] = useState<{ version: number; graph: FlowGraph } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
  // can express fan-in/fan-out the stack cannot). Additive — the stack remains
  // the default until the DAG canvas reaches parity (insert menus, jam cursors,
  // container bodies).
  const [canvasMode, setCanvasModeState] = useState<'stack' | 'dag'>(() => {
    if (typeof window === 'undefined') return 'stack'
    return window.localStorage.getItem('flows.canvasMode') === 'dag' ? 'dag' : 'stack'
  })
  const setCanvasMode = useCallback((mode: 'stack' | 'dag') => {
    setCanvasModeState(mode)
    if (typeof window !== 'undefined') window.localStorage.setItem('flows.canvasMode', mode)
  }, [])
  const [snapToGrid, setSnapToGrid] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('flows.snapToGrid') === 'true'
  })
  const canvasPanRef = useRef(canvasPan)
  canvasPanRef.current = canvasPan
  const jamCursorUpdateRef = useRef<(cursor: { x: number; y: number } | null) => void>(() => {})
  const panRef = useRef<ReturnType<typeof startCanvasPan>>(null)
  const suppressCanvasClickRef = useRef(false)
  const onCanvasPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = canvasScrollRef.current
    if (!container) return
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
    panRef.current?.move(event.clientX, event.clientY)
    jamCursorUpdateRef.current({
      x: Math.min(1, Math.max(0, event.clientX / window.innerWidth)),
      y: Math.min(1, Math.max(0, event.clientY / window.innerHeight)),
    })
  }, [])
  const onCanvasPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
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
  const [improvementSuggestions, setImprovementSuggestions] = useState<{ id: string; title: string; content: string }[]>([])
  const [dismissingSuggestionId, setDismissingSuggestionId] = useState<string | null>(null)
  // Optimistic-concurrency base: the flow's updatedAt as of load/last save.
  const baseUpdatedAtRef = useRef<string | undefined>(undefined)
  // Flow Jam: the server is the durable sequencer; Realtime accelerates graph,
  // cursor, and selected-widget presence without becoming the source of truth.
  const remoteGraphSnapshotRef = useRef<string | null>(null)
  const { peers, connectionState, broadcastGraph, updateCursor, broadcastAccessChange } = useFlowJam({
    flowId: id,
    enabled: !loading,
    selectedNodeId: selectedId,
    onRemoteGraph: (remote) => {
      remoteGraphSnapshotRef.current = JSON.stringify(remote)
      setGraph(remote)
    },
    onRemoteSaved: (updatedAt) => {
      baseUpdatedAtRef.current = updatedAt
    },
    onConflict: (message) => toast.warning(message, { duration: 8000 }),
  })
  jamCursorUpdateRef.current = updateCursor
  useEffect(() => {
    if (loading) return
    const snapshot = JSON.stringify(graph)
    if (remoteGraphSnapshotRef.current === snapshot) {
      remoteGraphSnapshotRef.current = null
      return
    }
    remoteGraphSnapshotRef.current = null
    broadcastGraph(graph)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, loading])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Run the user explicitly picked (dropdown or ?run= deep-link). While set,
  // the poll tick refreshes that run's details instead of stealing selection.
  const pinnedRunId = useRef<string | null>(null)
  const dirty = savedSnapshot !== '' && JSON.stringify({ name, description, graph, status }) !== savedSnapshot

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getCachedJson<any>('/api/flows'),
      getCachedJson<any>('/api/agents', 30_000),
    ])
      .then(([flowsData, agentsData]) => {
        if (cancelled) return
        const flow = (flowsData.flows || []).find((f: { id: string }) => f.id === id)
        if (flow) {
          const g = flow.graph && flow.graph.nodes ? flow.graph : emptyGraph()
          setName(flow.name)
          setDescription(flow.description || '')
          setGraph(g)
          setStatus(flow.status)
          setVersion(flow.version ?? 1)
          setPublished(Boolean(flow.published))
          setCanManageJam(Boolean(flow.canManageJam))
          setVisibility(typeof flow.visibility === 'string' ? flow.visibility : 'private')
          setSavedSnapshot(JSON.stringify({ name: flow.name, description: flow.description || '', graph: g, status: flow.status }))
          baseUpdatedAtRef.current = flow.updatedAt
        }
        setAgents(agentsData.success ? agentsData.agents.map((a: Agent) => ({ id: a.id, title: a.title })) : [])
      })
      .catch(() => undefined)
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
  }, [id])

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

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Undo/redo history over structural graph edits (not per-keystroke field edits).
  const undoStack = useRef<FlowGraph[]>([])
  const redoStack = useRef<FlowGraph[]>([])
  const commitGraph = useCallback(
    (next: FlowGraph) => {
      if (next === graph) return
      undoStack.current.push(graph)
      if (undoStack.current.length > 50) undoStack.current.shift()
      redoStack.current = []
      setGraph(next)
    },
    [graph],
  )
  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(graph)
    setGraph(prev)
    setSelectedId(null)
  }, [graph])
  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(graph)
    setGraph(next)
    setSelectedId(null)
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
  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      // isContentEditable covers the TokenTextEditor chip fields (tagName DIV):
      // without it, Backspace inside a chip editor would delete the whole step.
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (viewingVersion) return
        if (selectedId && selectedId !== 'trigger') {
          e.preventDefault()
          commitGraph(deleteNode(graph, selectedId))
          setSelectedId(null)
          toast.success('Step deleted — ⌘Z to undo.')
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        if (selectedNode && selectedNode.type !== 'trigger') {
          e.preventDefault()
          writeFlowClipboard(selectedNode)
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
        const afterId = selectedId && selectedId !== 'trigger' ? selectedId : ids[ids.length - 1] ?? 'trigger'
        const { graph: next, nodeId } = pasteNodeAfter(graph, afterId, copied)
        commitGraph(next)
        setSelectedId(nodeId)
        toast.success('Step pasted.')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, selectedId, selectedNode, graph, commitGraph, viewingVersion])

  const loopContext = useMemo(() => parentLoop(graph, selectedId), [graph, selectedId])
  const parallelContext = useMemo(() => parentParallelBranch(graph, selectedId), [graph, selectedId])
  const insideLoop = Boolean(loopContext)
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

  // The datatree of mappable upstream data — declared output fields plus fields
  // inferred from the latest run's actual output.
  const dataFields = useMemo(() => {
    if (!selectedNode || selectedNode.type === 'trigger') return []
    const lastOutputs: Record<string, unknown> = {}
    for (const step of selectedRun?.steps ?? []) lastOutputs[step.nodeId] = parseFlowValue(step.output)
    const triggerInput = testInput.trim() ? parseFlowInput(testInput) : storedRunInput(selectedRun?.input)
    if (loopContext) {
      const sampleInput = typeof triggerInput === 'string' ? triggerInput : triggerInput == null ? '' : JSON.stringify(triggerInput)
      lastOutputs.__item = sampleLoopItem(loopContext.loop, lastOutputs, sampleInput)
    }
    const upstream = upstreamIds.map((uid) => {
      const n = graph.nodes.find((x) => x.id === uid)
      const label =
        n?.type === 'agent'
          ? n.data.label || agentsById.get(n.data.agentId) || 'Agent step'
          : n?.type === 'tool'
            ? n.data.label || n.data.toolName || 'Tool call'
            : n?.type === 'http'
              ? n.data.label || `${n.data.method} request`
              : n
                ? ('label' in n.data && n.data.label) || defaultStepLabel(n)
                : uid
      const outputFields = outputFieldsForNode(n, toolCatalog)
      return { id: uid, label, outputFields }
    })
    return buildDataTree({ upstream, insideLoop, lastOutputs, triggerInput, inputFields, variables: upstreamVariables })
  }, [selectedNode, upstreamIds, graph, selectedRun, insideLoop, agentsById, loopContext, testInput, inputFields, toolCatalog, upstreamVariables])

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
    setSaving(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, description, graph, status: status.toUpperCase(), baseUpdatedAt: baseUpdatedAtRef.current }),
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
      setSavedSnapshot(JSON.stringify({ name, description, graph, status }))
      return true
    } finally {
      setSaving(false)
    }
  }, [id, name, description, graph, status])

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
        if (revert && data.flow?.graph) setGraph(data.flow.graph)
        setVersion(data.flow?.version ?? version)
        setPublished(Boolean(data.flow?.published))
        toast.success(revert ? 'Reverted to the published version.' : `Published v${data.flow?.version}.`)
      } finally {
        setPublishing(false)
      }
    },
    [id, save, validation, version],
  )

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
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(tick, 2000)
    tick()
  }, [id])

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
        if (latest && (latest.status === 'running' || latest.status === 'waiting') && !searchParams.get('run')) {
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
        commitGraph(data.flow.graph)
        setSavedSnapshot(JSON.stringify({ name, description, graph: data.flow.graph, status }))
        setViewingVersion(null)
        toast.success(`Restored v${v} into the draft.`)
      } else {
        toast.error(data.error || 'Could not restore that version.')
      }
    },
    [id, commitGraph, name, description, status],
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
      else if (data.run?.status === 'queued' || data.run?.status === 'running') toast.success('Flow started — running in the background.')
      else toast.success('Flow ran.')
      pollRuns()
    } finally {
      setRunning(false)
    }
  }, [id, save, pollRuns, testInput, validation, inputFields, viewingVersion])

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
   * (and the redaction — credentials never leave), and streams a file back, so
   * this just follows the download.
   */
  const exportFlow = useCallback(
    async (target: 'portable' | 'n8n' | 'workato' | 'power-automate' | 'instructions') => {
      try {
        const response = await fetch(`/api/flows/${id}/export?target=${target}`, { cache: 'no-store' })
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
            : 'Exported. Credentials were not included — the file lists what to reconnect.',
        )
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Export failed')
      }
    },
    [id],
  )

  const downloadFlow = useCallback(() => {
    const flowName = name.trim() || 'Untitled flow'
    const payload = {
      name: flowName,
      description,
      status,
      version,
      graph,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${filenameSlug(flowName)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [name, description, status, version, graph])

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

  // While viewing a historical snapshot, the canvas renders that version's
  // graph and every mutation path is inert — the live draft (`graph` state)
  // is untouched underneath, so Save/Publish/Run still act on the real draft.
  const canvasGraph = viewingVersion ? viewingVersion.graph : graph

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" onClick={() => router.push('/flows')} aria-label="Back to flows">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-base font-semibold outline-none hover:bg-muted focus:bg-muted"
          placeholder="Untitled flow"
        />
        <Button variant="ghost" size="icon" onClick={undo} aria-label="Undo" title="Undo (⌘Z)">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={redo} aria-label="Redo" title="Redo (⌘⇧Z)">
          <Redo2 className="h-4 w-4" />
        </Button>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none"
        >
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Flow settings" title="Flow settings">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Flow settings</DropdownMenuLabel>
            <DropdownMenuItem onSelect={duplicateFlow}>
              <Copy className="h-4 w-4" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={downloadFlow}>
              <Download className="h-4 w-4" /> Download JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Take this workflow elsewhere. Credentials are never included —
                the export states what has to be reconnected on the other side. */}
            <DropdownMenuLabel>Export to another platform</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => exportFlow('portable')}>
              <Download className="h-4 w-4" /> Portable JSON (any platform)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportFlow('n8n')}>
              <Download className="h-4 w-4" /> n8n workflow (import-ready)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportFlow('workato')}>
              <Download className="h-4 w-4" /> Workato recipe (linear — merges noted)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportFlow('power-automate')}>
              <Download className="h-4 w-4" /> Power Automate flow (import-ready)
            </DropdownMenuItem>
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
            agent); the stack view keeps insert menus + jam cursors until the DAG
            canvas reaches parity. */}
        <div className="flex items-center rounded-lg border border-slate-200 p-0.5">
          {(['stack', 'dag'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setCanvasMode(mode)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                canvasMode === mode ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-900',
              )}
              title={mode === 'dag' ? 'Free-form canvas — wire multiple steps into one' : 'Classic stack view'}
            >
              {mode === 'stack' ? 'Stack' : 'Canvas'}
            </button>
          ))}
        </div>
        <JamButton flowId={id} peers={peers} connectionState={connectionState} canManage={canManageJam} onAccessChanged={broadcastAccessChange} />
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
        <Button variant="outline" size="sm" onClick={() => publish(false)} loading={publishing} title={published ? `Published v${version}` : 'Not yet published'}>
          {published ? `Publish v${version + 1}` : 'Publish'}
        </Button>
        {published && (
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
        {/* DAG mode owns its own pan/zoom/background (React Flow), so it renders
            OUTSIDE the stack canvas's scroll + transform wrapper. */}
        {canvasMode === 'dag' ? (
          // Reuses the stack canvas's pointer handler so a teammate still sees
          // this user's Jam cursor here (panRef is null in DAG mode, so its
          // pan-drag call safely no-ops). JamCursorOverlay is page-level, so
          // peers' cursors already render over either canvas.
          <div
            className="min-w-0 flex-1 bg-white"
            onPointerMove={onCanvasPointerMove}
            onPointerLeave={() => jamCursorUpdateRef.current(null)}
          >
            <DagCanvas
              graph={canvasGraph}
              agents={agents}
              toolCatalog={toolCatalog}
              dataFields={dataFields}
              variableNames={upstreamVariables.map((variable) => variable.name)}
              statusByNode={viewingVersion ? {} : statusByNode}
              issuesByNode={viewingVersion ? undefined : issuesByNode}
              highlightIds={viewingVersion ? [] : highlightIds}
              jamPeers={peers}
              selectedId={selectedId}
              readOnly={Boolean(viewingVersion)}
              labelOf={(node) => labelCtx.stepLabels[node.id] || defaultStepLabel(node)}
              onSelect={viewingVersion ? () => {} : setSelectedId}
              onChangeNode={viewingVersion ? () => {} : (node) => setGraph((g) => updateNode(g, node))}
              onChangeGraph={viewingVersion ? () => {} : commitGraph}
              onAddNode={
                viewingVersion
                  ? () => {}
                  : (type, seed, position) => {
                      // Same seed handling as the stack's insert path, minus the
                      // chain splice — on the canvas the user wires it up.
                      const { graph: added, nodeId } = addNodeAt(graph, type, position, type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined)
                      commitGraph(applyInsertSeed(added, nodeId, seed))
                      setSelectedId(nodeId)
                    }
              }
              // Container editing happens in the node's config panel (the widget
              // itself stays small) — same mutations the stack view uses.
              onReorderContainer={
                viewingVersion
                  ? undefined
                  : (containerId, from, to, branchIndex) => commitGraph(moveContainerStep(graph, containerId, from, to, branchIndex))
              }
              onAddContainerStep={
                viewingVersion
                  ? undefined
                  : (containerId, type) => {
                      const { graph: next, nodeId } = addContainerStep(graph, containerId, type, type === 'agent' ? agents[0]?.id ?? '' : undefined)
                      commitGraph(next)
                      setSelectedId(nodeId)
                    }
              }
            />
          </div>
        ) : (
        <div
          ref={canvasScrollRef}
          className="min-w-0 flex-1 cursor-grab overflow-y-auto bg-white p-8"
          onClick={() => {
            // A completed drag-to-scroll must not read as a background click.
            if (suppressCanvasClickRef.current) {
              suppressCanvasClickRef.current = false
              return
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
          }}
        >
          <div
            style={{
              // Translate first (screen-pixel pan), then scale (zoom). Fit resets both.
              transform: `translate(${canvasPan.x}px, ${canvasPan.y}px) scale(${zoom})`,
              transformOrigin: 'top center',
              width: `${100 / zoom}%`,
              marginLeft: `${(1 - 1 / zoom) * 50}%`,
            }}
          >
            <FlowCanvas
              graph={canvasGraph}
              flowId={id}
              agentName={(agentId) => agentsById.get(agentId) ?? ''}
              agents={agents}
              toolCatalog={toolCatalog}
              dataFields={dataFields}
              labelCtx={labelCtx}
              variableNames={upstreamVariables.map((variable) => variable.name)}
              statusByNode={viewingVersion ? {} : statusByNode}
              issuesByNode={viewingVersion ? undefined : issuesByNode}
              highlightIds={viewingVersion ? [] : highlightIds}
              selectedId={selectedId}
              onSelect={viewingVersion ? () => {} : setSelectedId}
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
              onRefreshAgents={refreshAgents}
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
              onChangeNodeType={viewingVersion ? undefined : (nodeId, type) => commitGraph(changeNodeType(graph, nodeId, type))}
              onAddContainerStep={
                viewingVersion
                  ? undefined
                  : (containerId, type) => {
                      const { graph: next, nodeId } = addContainerStep(graph, containerId, type, type === 'agent' ? agents[0]?.id ?? '' : undefined)
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
          <ResizablePanel storageKey="flow.copilotWidth">
            <CopilotPanel
              graph={graph}
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
              selectedNodeId={selectedId && selectedId !== 'trigger' ? selectedId : undefined}
              selectedNodeLabel={selectedId && selectedId !== 'trigger' ? labelForNode(selectedId) : undefined}
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
              runs={runs}
              selected={selectedRun}
              onSelectRun={selectRun}
              onClose={() => setShowRuns(false)}
              labelForNode={labelForNode}
              onReply={replyToRun}
              remediation={runtimeRemediation}
              onRemediate={remediateFailure}
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
              onView={viewVersion}
              onRestore={restoreVersion}
              onClose={() => setShowVersions(false)}
            />
          </ResizablePanel>
        )}
      </div>
      <JamCursorOverlay peers={peers} />
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
