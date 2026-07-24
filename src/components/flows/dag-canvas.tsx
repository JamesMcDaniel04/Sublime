'use client'

/**
 * Free-form DAG canvas (sub-project ②) — the builder surface for the DAG engine,
 * modelled on n8n: a horizontal left→right pipeline of SMALL node widgets you
 * drag and wire, with configuration in a side panel rather than on the card.
 *
 * Why small widgets: the old canvas rendered a full editor per step in a
 * vertical stack, so a graph could only ever be a chain and the canvas was
 * unreadable past a few steps. Here a node is an icon + name; inputs enter on the
 * LEFT handle and outputs leave on the RIGHT, so a user can wire many→many —
 * three APIs into one agent, or one API into three agents. The engine already
 * executes exactly this shape (fan-out, wait-for-all joins, edge-scoped context).
 *
 * Layout lives in `graph.layout` (a view concern, keyed by node id). A graph with
 * no layout — every flow authored before this — is auto-laid-out with dagre on
 * open; nothing is persisted until the user actually drags something.
 *
 * Container-body nodes (loop/parallel/errorShield children) are NOT top-level
 * widgets — their container owns them, mirroring the interpreter's `contained`
 * set — so they're edited, reordered, and added inside the container's panel.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ViewportPortal,
  useStore,
  useViewport,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import { AlertCircle, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { StepCard, type StepStatus } from './step-card'
import { AddStepMenu } from './add-step-menu'
import { FlowPicker } from './flow-picker'
import { NODE_TYPE_LABEL, nodeIconOf, nodeToneOf, type EditableType } from './node-types'
import type { FlowInsertSeed } from './flow-canvas'
import type { ToolCatalog } from './tool-catalog-type'
import { autoLayout, containedNodeIds } from '@/lib/flows/auto-layout'
import { connectNodes, disconnectEdge, moveNodeTo, type StepType } from '@/lib/flows/mutate'
import { cn } from '@/lib/utils'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { edgeIndicator, flowToScreenPoint, type JamCursor } from '@/lib/flows/jam-presence'
import { jamCursorColor, type JamPeer } from './use-flow-jam'
import { CommentPinMarker, type CommentPinData } from './flow-comments'

type Agent = { id: string; title: string }
type NodeIssues = { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }

/** Compact widget footprint — deliberately small so a big graph stays readable. */
const WIDGET_WIDTH = 210

/** The child ids a container owns — mirrors auto-layout/interpreter `contained`. */
function containerChildIds(node: FlowNode): string[] {
  return node.type === 'loop' || node.type === 'repeatUntil' ? node.data.body
    : node.type === 'parallel' ? node.data.branches.flat()
    : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
    : []
}

const isContainerNode = (node: FlowNode) =>
  node.type === 'loop' || node.type === 'repeatUntil' || node.type === 'parallel' || node.type === 'errorShield'

/**
 * The sibling list a contained id can be reordered WITHIN, and the branch marker
 * `onReorderContainer` expects. Mirrors the stack canvas exactly: a parallel
 * branch reorders only within its own branch array, and an errorShield's
 * fallback list is marked with branchIndex -1 (insertIntoContainer's convention).
 */
function siblingsOf(container: FlowNode, childId: string): { list: string[]; branchIndex?: number } {
  if (container.type === 'loop' || container.type === 'repeatUntil') return { list: container.data.body }
  if (container.type === 'parallel') {
    const branchIndex = container.data.branches.findIndex((branch) => branch.includes(childId))
    return { list: branchIndex >= 0 ? container.data.branches[branchIndex] : [], branchIndex: branchIndex >= 0 ? branchIndex : undefined }
  }
  if (container.type === 'errorShield') {
    return container.data.body.includes(childId) ? { list: container.data.body } : { list: container.data.fallback, branchIndex: -1 }
  }
  return { list: [] }
}


type WidgetData = {
  node: FlowNode
  title: string
  status?: StepStatus
  issues?: NodeIssues
  highlighted: boolean
  selected: boolean
  jamEditors: JamPeer[]
  childCount: number
  /** Whether any wire already leaves this node — leaves show their "+" always. */
  hasOutgoing: boolean
  onOpen: (id: string) => void
  /** Open the quick-add picker wired from this node (absent when read-only). */
  onQuickAdd?: (id: string) => void
}

/** Gap between a node and its quick-added successor (≈ dagre's RANK_SEP). */
const QUICK_ADD_GAP = 110
/** Vertical fan step for a source that already has children — the new node
 *  lands below its siblings instead of on top of them, n8n style. */
const QUICK_ADD_FAN_STEP = 96

const STATUS_DOT: Partial<Record<StepStatus, string>> = {
  running: 'bg-blue-500 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-amber-500',
  skipped: 'bg-muted-foreground/40',
}

/**
 * A small node widget: icon, name, and the handles that ARE the DAG (dragging
 * right→left creates an edge, which is both an execution dependency and a data
 * path). Clicking opens the config panel — nothing is edited on the card itself.
 */
function StepWidget({ data }: Readonly<NodeProps>) {
  const step = data as unknown as WidgetData
  const Icon = nodeIconOf(step.node.type)
  const errors = step.issues?.errors ?? 0
  return (
    <div className="group relative" style={{ width: WIDGET_WIDTH }}>
      {step.node.type !== 'trigger' && (
        <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground hover:!bg-blue-500" />
      )}
      <button
        type="button"
        onClick={() => step.onOpen(step.node.id)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl border bg-card p-2.5 text-left shadow-sm transition-all hover:shadow-md',
          step.selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-border hover:border-blue-300',
          step.highlighted && 'ring-2 ring-amber-300',
        )}
        // A peer on this step outlines it in THEIR cursor color — selection
        // presence that works even across canvas modes.
        style={
          step.jamEditors.length > 0
            ? { boxShadow: `0 0 0 2px white, 0 0 0 4px ${jamCursorColor(step.jamEditors[0].userId)}` }
            : undefined
        }
      >
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', nodeToneOf(step.node.type))}>
          <Icon className="h-4.5 w-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{step.title}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {NODE_TYPE_LABEL[step.node.type] ?? step.node.type}
            {step.childCount > 0 && ` · ${step.childCount} inside`}
          </span>
        </span>
        {errors > 0 && <AlertCircle className="h-4 w-4 shrink-0 text-red-500" aria-label={`${errors} errors`} />}
        {step.status && <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[step.status] ?? 'bg-muted-foreground/40')} />}
      </button>
      {/* Who else is on this step right now (Flow Jam), in their cursor color. */}
      {step.jamEditors.length > 0 && (
        <div className="mt-1 flex gap-1">
          {step.jamEditors.map((peer) => (
            <span
              key={peer.clientId}
              className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold text-white"
              style={{ backgroundColor: jamCursorColor(peer.userId) }}
              title={`${peer.name} is editing`}
            >
              {peer.name.slice(0, 12)}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground hover:!bg-blue-500" />
      {/* Quick-add: the n8n end-of-node "+" — appends a step already wired from
          here. Always visible on a leaf (the natural "what's next?" spot);
          hover-revealed once the node has children, so fanned graphs stay calm. */}
      {step.onQuickAdd && (
        <div
          className={cn(
            'absolute top-1/2 flex -translate-y-1/2 items-center',
            step.hasOutgoing && 'opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
          )}
          style={{ left: WIDGET_WIDTH + 6 }}
        >
          <span className="h-px w-4 bg-border" aria-hidden="true" />
          <button
            type="button"
            aria-label="Add a connected step"
            title="Add a connected step"
            onClick={(event) => {
              event.stopPropagation()
              step.onQuickAdd?.(step.node.id)
            }}
            className="nodrag nopan flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:border-blue-400 hover:text-blue-600"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

// Stable identity — React Flow re-mounts every node if this object changes.
const nodeTypes = { step: StepWidget }

/**
 * Comment pins in FLOW coordinates via ViewportPortal — same projection as the
 * Jam cursors, counter-scaled about the teardrop's tip so it stays anchored to
 * the exact spot at any zoom.
 */
function JamDagCommentPins({ pins, onPinClick }: Readonly<{ pins: CommentPinData[]; onPinClick?: (rootId: string) => void }>) {
  const viewport = useViewport()
  if (pins.length === 0) return null
  return (
    <ViewportPortal>
      {pins.map((pin) => (
        <div key={pin.id} className="absolute h-0 w-0" style={{ transform: `translate(${pin.x}px, ${pin.y}px)` }}>
          <div className="absolute bottom-0 left-0" style={{ transform: `scale(${1 / viewport.zoom})`, transformOrigin: 'bottom left' }}>
            <CommentPinMarker pin={pin} onClick={() => onPinClick?.(pin.id)} />
          </div>
        </div>
      ))}
    </ViewportPortal>
  )
}

/**
 * Peers' live cursors, rendered in FLOW coordinates via ViewportPortal so each
 * viewer's own pan/zoom projects them — a peer pointing at a node shows at that
 * node on every screen. Counter-scaled so the cursor stays constant screen
 * size, Figma-style. Off-screen peers pin to the canvas edge with an arrow
 * pointing toward them.
 */
function JamDagCursors({ peers }: Readonly<{ peers: JamPeer[] }>) {
  const viewport = useViewport()
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  const live = peers.filter(
    (peer): peer is JamPeer & { cursor: JamCursor } => peer.cursor?.space === 'dag',
  )
  if (live.length === 0) return null
  return (
    <>
      <ViewportPortal>
        {live.map((peer) => (
          <div
            key={peer.clientId}
            className="pointer-events-none absolute transition-transform duration-75 ease-linear"
            style={{
              transform: `translate(${peer.cursor.point.x}px, ${peer.cursor.point.y}px) scale(${1 / viewport.zoom})`,
              transformOrigin: 'top left',
            }}
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
      </ViewportPortal>
      {/* Edge indicators live in SCREEN space over the canvas container. */}
      <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
        {live.map((peer) => {
          const screen = flowToScreenPoint(peer.cursor.point, viewport)
          const edge = edgeIndicator(screen, { width, height }, 28)
          if (!edge) return null
          return (
            <div
              key={peer.clientId}
              className="absolute flex items-center gap-1"
              style={{ left: edge.x, top: edge.y, transform: 'translate(-50%, -50%)' }}
              title={`${peer.name} is here — off screen`}
            >
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-bold text-white shadow"
                style={{ backgroundColor: jamCursorColor(peer.userId) }}
              >
                {peer.name.charAt(0).toUpperCase()}
              </span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                className="absolute -right-2 -top-1"
                style={{ transform: `rotate(${edge.angle}deg)` }}
                aria-hidden="true"
              >
                <path d="M0 5L10 0v10L0 5z" transform="rotate(180 5 5)" fill={jamCursorColor(peer.userId)} />
              </svg>
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * Config panel for the selected node (n8n's "open the node" surface). Hosts the
 * full StepCard — every editor already lives there — plus, for containers, their
 * children: editable, drag-reorderable, and extendable. That's why the canvas
 * widget can stay small.
 */
function NodeConfigPanel({
  node,
  graph,
  title,
  labelOf,
  issuesByNode,
  readOnly,
  onOpenNode,
  onClose,
  onChangeNode,
  onSelect,
  onReorderContainer,
  onAddContainerStep,
}: Readonly<{
  node: FlowNode
  graph: FlowGraph
  title: string
  labelOf: (node: FlowNode) => string
  issuesByNode?: Record<string, NodeIssues>
  readOnly: boolean
  /** Open the Node Detail View — the drawer's cards are summaries now. */
  onOpenNode?: (id: string) => void
  onClose: () => void
  onChangeNode: (node: FlowNode) => void
  /** Focus a different node in this panel (e.g. a container child card). */
  onSelect?: (id: string) => void
  onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void
  onAddContainerStep?: (containerId: string, type: EditableType, branchIndex?: number) => void
}>) {
  const [dragId, setDragId] = useState<string | null>(null)
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes])
  const children = containerChildIds(node)
    .map((id) => byId.get(id))
    .filter((child): child is FlowNode => Boolean(child))

  return (
    <aside className="flex h-full w-[28rem] max-w-[92vw] shrink-0 flex-col border-l border-border bg-muted">
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <p className="truncate text-sm font-semibold text-foreground">{title}</p>
        <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <StepCard
          node={node}
          title={title}
          issues={issuesByNode?.[node.id]}
          selected
          labelCtx={{} as never}
          onChange={readOnly ? () => {} : onChangeNode}
          onClick={() => {}}
          onOpen={!readOnly && onOpenNode ? () => onOpenNode(node.id) : undefined}
        />
        {isContainerNode(node) && (
          <div className="space-y-2 rounded-2xl border border-dashed border-border bg-card/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Steps inside</p>
            {children.map((child) => {
              const { list, branchIndex } = siblingsOf(node, child.id)
              return (
                <div
                  key={child.id}
                  draggable={!readOnly}
                  onDragStart={(event) => {
                    setDragId(child.id)
                    event.dataTransfer.setData('text/flow-node-id', child.id)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(event) => {
                    // Only a sibling from the SAME list may drop here — a parallel
                    // branch never reorders into another branch.
                    if (dragId && dragId !== child.id && list.includes(dragId)) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }
                  }}
                  onDrop={(event) => {
                    const draggedId = event.dataTransfer.getData('text/flow-node-id')
                    if (draggedId && draggedId !== child.id && list.includes(draggedId)) {
                      event.preventDefault()
                      onReorderContainer?.(node.id, list.indexOf(draggedId), list.indexOf(child.id), branchIndex)
                    }
                    setDragId(null)
                  }}
                  className={cn('rounded-xl transition-opacity', dragId === child.id && 'opacity-50')}
                >
                  <StepCard
                    node={child}
                    title={labelOf(child)}
                    issues={issuesByNode?.[child.id]}
                    selected={false}
                    labelCtx={{} as never}
                    draggable={!readOnly}
                    onChange={readOnly ? () => {} : onChangeNode}
                    onClick={() => onSelect?.(child.id)}
                    onOpen={!readOnly && onOpenNode ? () => onOpenNode(child.id) : undefined}
                  />
                </div>
              )
            })}
            {!readOnly && onAddContainerStep && node.type !== 'errorShield' && <AddStepMenu onPick={(type) => onAddContainerStep(node.id, type)} />}
          </div>
        )}
      </div>
    </aside>
  )
}

export function DagCanvas({
  graph,
  agents,
  toolCatalog,
  statusByNode,
  issuesByNode,
  highlightIds,
  jamPeers,
  selectedId,
  readOnly = false,
  labelOf,
  onSelect,
  onOpenNode,
  onChangeNode,
  onChangeGraph,
  onAddNode,
  onReorderContainer,
  onAddContainerStep,
  onCursorMove,
  onRfInit,
  onUserPan,
  commentPins,
  onPinClick,
  placingPin = false,
  onPlacePin,
}: Readonly<{
  graph: FlowGraph
  agents: Agent[]
  toolCatalog: ToolCatalog
  statusByNode?: Record<string, StepStatus>
  issuesByNode?: Record<string, NodeIssues>
  highlightIds?: string[]
  jamPeers?: JamPeer[]
  selectedId?: string | null
  readOnly?: boolean
  /** Display label for a node (the builder derives these via stepLabelsOf). */
  labelOf: (node: FlowNode) => string
  onSelect: (id: string | null) => void
  /** Open the Node Detail View for a node — the drawer's cards are summaries now. */
  onOpenNode?: (id: string) => void
  onChangeNode: (node: FlowNode) => void
  /** Structural change (wire added/removed, widget moved). */
  onChangeGraph: (graph: FlowGraph) => void
  /** Add a step at `position`; `connectFrom` (quick-add / drag-to-canvas) also
   *  wires it from that node in the same commit, `connectBranch` labelling the
   *  wire with a branch node's chosen output. */
  onAddNode: (type: StepType, seed: FlowInsertSeed | undefined, position: { x: number; y: number }, connectFrom?: string, connectBranch?: string) => void
  onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void
  onAddContainerStep?: (containerId: string, type: EditableType, branchIndex?: number) => void
  /** Local pointer position in FLOW coordinates + current viewport (Jam cursor). */
  onCursorMove?: (cursor: JamCursor | null) => void
  /** Hands the React Flow instance up for follow mode's setViewport. */
  onRfInit?: (instance: ReactFlowInstance) => void
  /** A USER pan/zoom gesture (not programmatic) — breaks follow mode. */
  onUserPan?: () => void
  /** Open point-anchored comment threads to render as canvas pins. */
  commentPins?: CommentPinData[]
  onPinClick?: (rootId: string) => void
  /** Comment placement mode: the next pane click drops a pin instead of deselecting. */
  placingPin?: boolean
  onPlacePin?: (point: { x: number; y: number }) => void
}>) {
  // Positions: stored layout wins, dagre fills the rest. Legacy flows (no layout
  // at all) get a full arrangement without persisting anything.
  const layout = useMemo(() => autoLayout(graph), [graph])
  const contained = useMemo(() => containedNodeIds(graph), [graph])
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  const selectedNode = selectedId ? byId.get(selectedId) : undefined
  // A container child is edited in its container's panel, never as a top-level widget.
  const panelNode = selectedNode && !contained.has(selectedNode.id) ? selectedNode : undefined

  // Quick-add: which node the picked step will be wired FROM, and where it
  // lands. Branch nodes (If/else, Switch, AI router) must first answer "which
  // output?" — the engine treats a PLAIN edge from them as a fallback that
  // never runs once every output is wired, so `options` renders a chooser and
  // `branch` carries the answer onto the new wire.
  const [quickAdd, setQuickAdd] = useState<{
    sourceId: string
    position: { x: number; y: number }
    branch?: string
    options?: { value: string; label: string }[]
  } | null>(null)

  /** The outputs a branch node can emit — null for ordinary nodes. */
  const branchOptionsOf = (node: FlowNode | undefined): { value: string; label: string }[] | null => {
    if (!node) return null
    if (node.type === 'condition') return [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]
    if (node.type === 'switch') {
      return [...node.data.cases.map((entry) => ({ value: entry.id, label: entry.id })), { value: 'default', label: 'Default' }]
    }
    if (node.type === 'router') {
      return [...node.data.branches.map((entry) => ({ value: entry.id, label: entry.label?.trim() || entry.id })), { value: 'default', label: 'Default' }]
    }
    return null
  }

  const startQuickAdd = useCallback(
    (sourceId: string, position: { x: number; y: number }) => {
      const options = branchOptionsOf(byId.get(sourceId))
      setQuickAdd(options ? { sourceId, position, options } : { sourceId, position })
    },
     
    [byId],
  )

  const outgoingCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const edge of graph.edges) {
      if (!contained.has(edge.source) && !contained.has(edge.target)) {
        counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
      }
    }
    return counts
  }, [graph.edges, contained])

  // The "+" drops the new step one rank to the right, fanned below any children
  // the source already has — so repeated quick-adds build a visible fan-out.
  const openQuickAdd = useCallback(
    (sourceId: string) => {
      const source = layout[sourceId] ?? { x: 0, y: 0 }
      const fan = outgoingCount.get(sourceId) ?? 0
      startQuickAdd(sourceId, { x: source.x + WIDGET_WIDTH + QUICK_ADD_GAP, y: source.y + fan * QUICK_ADD_FAN_STEP })
    },
    [layout, outgoingCount, startQuickAdd],
  )

  const rfNodes: Node[] = useMemo(
    () =>
      graph.nodes
        .filter((node) => !contained.has(node.id))
        .map((node) => ({
          id: node.id,
          type: 'step',
          position: layout[node.id] ?? { x: 0, y: 0 },
          draggable: !readOnly,
          data: {
            node,
            title: labelOf(node),
            status: statusByNode?.[node.id],
            issues: issuesByNode?.[node.id],
            highlighted: Boolean(highlightIds?.includes(node.id)),
            selected: selectedId === node.id,
            jamEditors: jamPeers?.filter((peer) => peer.selectedNodeId === node.id) ?? [],
            childCount: containerChildIds(node).length,
            hasOutgoing: (outgoingCount.get(node.id) ?? 0) > 0,
            onOpen: onSelect,
            // A Stop step halts the run — a successor could never execute, so
            // it gets no append affordance.
            onQuickAdd: readOnly || node.type === 'stop' ? undefined : openQuickAdd,
          } satisfies WidgetData as unknown as Record<string, unknown>,
        })),
    [graph.nodes, contained, layout, readOnly, labelOf, statusByNode, issuesByNode, highlightIds, jamPeers, selectedId, onSelect, outgoingCount, openQuickAdd],
  )

  const rfEdges: Edge[] = useMemo(
    () =>
      graph.edges
        // A wire is only drawable when both ends are top-level widgets.
        .filter((edge) => !contained.has(edge.source) && !contained.has(edge.target))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.branch,
          deletable: !readOnly,
        })),
    [graph.edges, contained, readOnly],
  )

  // The instance powers cursor capture (screenToFlowPosition) locally and
  // follow mode (setViewport) up at the page level via onRfInit.
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || !connection.source || !connection.target) return
      const result = connectNodes(graph, connection.source, connection.target)
      // connectNodes refuses self-links, duplicates and cycles — surface WHY
      // rather than silently dropping the user's gesture.
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      onChangeGraph(result.graph)
    },
    [graph, readOnly, onChangeGraph],
  )

  const onEdgesDelete = useCallback(
    (edges: Edge[]) => {
      if (readOnly || !edges.length) return
      onChangeGraph(edges.reduce((next, edge) => disconnectEdge(next, edge.id), graph))
    },
    [graph, readOnly, onChangeGraph],
  )

  // n8n's other add gesture: drag a wire out of a source handle and release it
  // over empty canvas — the picker opens at the drop point and the picked step
  // arrives wired from where the drag started. Drops on a node (valid or
  // refused by connectNodes) are NOT an ask to add.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (readOnly || connectionState.isValid) return
      if (!connectionState.fromNode || connectionState.fromHandle?.type !== 'source' || connectionState.toNode) return
      const instance = rfInstance.current
      if (!instance) return
      const point = 'changedTouches' in event ? event.changedTouches[0] : event
      startQuickAdd(connectionState.fromNode.id, instance.screenToFlowPosition({ x: point.clientX, y: point.clientY }))
    },
    [readOnly, startQuickAdd],
  )

  // Persist on drag END only — committing every intermediate frame would spam
  // the graph (and Flow Jam) with hundreds of updates per drag.
  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      if (readOnly) return
      onChangeGraph(moveNodeTo(graph, node.id, node.position))
    },
    [graph, readOnly, onChangeGraph],
  )

  return (
    <div className="flex h-full w-full">
      <div
        className={cn('min-w-0 flex-1 bg-background', placingPin && '[&_.react-flow__pane]:!cursor-crosshair')}
        onPointerMove={(event) => {
          const instance = rfInstance.current
          if (!instance || !onCursorMove) return
          onCursorMove({
            space: 'dag',
            point: instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            viewport: instance.getViewport(),
          })
        }}
        onPointerLeave={() => onCursorMove?.(null)}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onEdgesDelete={onEdgesDelete}
          onNodeDragStop={onNodeDragStop}
          // Wires snap from further away — the 12px handles are precise enough
          // to read but too small to demand pixel-perfect drops.
          connectionRadius={36}
          onPaneClick={(event) => {
            const instance = rfInstance.current
            if (placingPin && onPlacePin && instance) {
              onPlacePin(instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
              return
            }
            onSelect(null)
          }}
          onInit={(instance) => {
            rfInstance.current = instance
            onRfInit?.(instance)
          }}
          // event is set only for USER gestures; programmatic setViewport
          // (follow mode itself) passes no event and must not break the follow.
          onMoveStart={(event) => {
            if (event) onUserPan?.()
          }}
          nodesConnectable={!readOnly}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Background gap={28} size={1} color="rgba(15, 23, 42, 0.22)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-card" />
          <JamDagCursors peers={jamPeers ?? []} />
          <JamDagCommentPins pins={commentPins ?? []} onPinClick={onPinClick} />
        </ReactFlow>
        {/* Quick-add: one overlay shared by every node's "+" and the
            drag-to-canvas gesture. Branch nodes interpose an output chooser;
            then the picked step is added at the captured position AND wired
            from the source (with the chosen output label) in a single commit. */}
        {quickAdd && !readOnly && (
          <>
            <button type="button" aria-label="Close" className="fixed inset-0 z-30 cursor-default" onClick={() => setQuickAdd(null)} />
            {quickAdd.options ? (
              <div className="fixed left-1/2 top-24 z-40 w-64 -translate-x-1/2 rounded-2xl border border-border bg-card p-3 shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Connect from which output?</p>
                {quickAdd.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setQuickAdd({ sourceId: quickAdd.sourceId, position: quickAdd.position, branch: option.value })}
                    className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="fixed left-1/2 top-24 z-40 max-h-[72vh] w-[34rem] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
                <FlowPicker
                  mode="action"
                  agents={agents}
                  toolCatalog={toolCatalog}
                  onPick={(type, seed) => {
                    onAddNode(type as StepType, seed, quickAdd.position, quickAdd.sourceId, quickAdd.branch)
                    setQuickAdd(null)
                  }}
                  onClose={() => setQuickAdd(null)}
                />
              </div>
            )}
          </>
        )}
      </div>
      {panelNode && (
        <NodeConfigPanel
          node={panelNode}
          graph={graph}
          title={labelOf(panelNode)}
          labelOf={labelOf}
          issuesByNode={issuesByNode}
          readOnly={readOnly}
          onOpenNode={onOpenNode}
          onClose={() => onSelect(null)}
          onSelect={onSelect}
          onChangeNode={onChangeNode}
          onReorderContainer={onReorderContainer}
          onAddContainerStep={onAddContainerStep}
        />
      )}
    </div>
  )
}
