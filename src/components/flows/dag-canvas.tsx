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
import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { AlertCircle, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { StepCard, type StepStatus } from './step-card'
import { FlowPicker } from './flow-picker'
import { NODE_TYPES, NODE_TYPE_LABEL, nodeIconOf, nodeToneOf, type EditableType } from './node-types'
import type { FlowInsertSeed } from './flow-canvas'
import type { ToolCatalog } from './tool-catalog-type'
import { autoLayout, containedNodeIds } from '@/lib/flows/auto-layout'
import { connectNodes, disconnectEdge, moveNodeTo, type StepType } from '@/lib/flows/mutate'
import { cn } from '@/lib/utils'
import type { DataField } from '@/lib/flows/datatree'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import type { JamPeer } from './use-flow-jam'

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

/** Compact "add a step" menu used inside a container's panel. */
function AddNestedStepMenu({ onPick }: Readonly<{ onPick: (type: EditableType) => void }>) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:border-blue-400 hover:text-blue-700"
      >
        <Plus className="h-4 w-4" /> Add a step
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
            {NODE_TYPES.map((type) => (
              <button
                key={type.value}
                type="button"
                onClick={() => { setOpen(false); onPick(type.value) }}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-slate-100"
              >
                {type.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
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
  onOpen: (id: string) => void
}

const STATUS_DOT: Partial<Record<StepStatus, string>> = {
  running: 'bg-blue-500 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-amber-500',
  skipped: 'bg-slate-300',
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
    <div style={{ width: WIDGET_WIDTH }}>
      {step.node.type !== 'trigger' && (
        <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-white !bg-slate-400 hover:!bg-blue-500" />
      )}
      <button
        type="button"
        onClick={() => step.onOpen(step.node.id)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl border bg-white p-2.5 text-left shadow-sm transition-all hover:shadow-md',
          step.selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200 hover:border-blue-300',
          step.highlighted && 'ring-2 ring-amber-300',
        )}
      >
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', nodeToneOf(step.node.type))}>
          <Icon className="h-4.5 w-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-950">{step.title}</span>
          <span className="block truncate text-[11px] text-slate-500">
            {NODE_TYPE_LABEL[step.node.type] ?? step.node.type}
            {step.childCount > 0 && ` · ${step.childCount} inside`}
          </span>
        </span>
        {errors > 0 && <AlertCircle className="h-4 w-4 shrink-0 text-red-500" aria-label={`${errors} errors`} />}
        {step.status && <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[step.status] ?? 'bg-slate-300')} />}
      </button>
      {/* Who else is on this step right now (Flow Jam). */}
      {step.jamEditors.length > 0 && (
        <div className="mt-1 flex gap-1">
          {step.jamEditors.map((peer) => (
            <span key={peer.clientId} className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[9px] font-semibold text-white" title={`${peer.name} is editing`}>
              {peer.name.slice(0, 12)}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-white !bg-slate-400 hover:!bg-blue-500" />
    </div>
  )
}

// Stable identity — React Flow re-mounts every node if this object changes.
const nodeTypes = { step: StepWidget }

/**
 * "Add step" for the canvas. Lives inside <ReactFlow> so it can use
 * `screenToFlowPosition` to drop the new widget where the user is looking.
 */
function AddStepPanel({
  agents,
  toolCatalog,
  onAddNode,
}: Readonly<{
  agents: Agent[]
  toolCatalog: ToolCatalog
  onAddNode: (type: StepType, seed: FlowInsertSeed | undefined, position: { x: number; y: number }) => void
}>) {
  const { screenToFlowPosition } = useReactFlow()
  const [open, setOpen] = useState(false)
  return (
    <Panel position="top-left">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:border-blue-400 hover:text-blue-700"
      >
        <Plus className="h-4 w-4" /> Add step
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute z-40 mt-2 max-h-[72vh] w-[34rem] max-w-[90vw] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
            <FlowPicker
              mode="action"
              agents={agents}
              toolCatalog={toolCatalog}
              onPick={(type, seed) => {
                const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
                onAddNode(type as StepType, seed, position)
                setOpen(false)
              }}
              onClose={() => setOpen(false)}
            />
          </div>
        </>
      )}
    </Panel>
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
  cardProps,
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
  cardProps: { agents: Agent[]; toolCatalog: ToolCatalog; dataFields: DataField[]; variableNames: string[] }
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
    <aside className="flex h-full w-[28rem] max-w-[92vw] shrink-0 flex-col border-l border-slate-200 bg-slate-50">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <p className="truncate text-sm font-semibold text-slate-950">{title}</p>
        <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <StepCard
          {...cardProps}
          node={node}
          title={title}
          issues={issuesByNode?.[node.id]}
          selected
          labelCtx={{} as never}
          onChange={readOnly ? () => {} : onChangeNode}
          onClick={() => {}}
          onAddStep={!readOnly && node.type === 'errorShield' && onAddContainerStep ? (type, branchIndex) => onAddContainerStep(node.id, type, branchIndex) : undefined}
        />
        {isContainerNode(node) && (
          <div className="space-y-2 rounded-2xl border border-dashed border-slate-300 bg-white/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Steps inside</p>
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
                    {...cardProps}
                    node={child}
                    title={labelOf(child)}
                    issues={issuesByNode?.[child.id]}
                    selected={false}
                    labelCtx={{} as never}
                    draggable={!readOnly}
                    onChange={readOnly ? () => {} : onChangeNode}
                    onClick={() => onSelect?.(child.id)}
                  />
                </div>
              )
            })}
            {!readOnly && onAddContainerStep && node.type !== 'errorShield' && <AddNestedStepMenu onPick={(type) => onAddContainerStep(node.id, type)} />}
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
  dataFields = [],
  variableNames = [],
  statusByNode,
  issuesByNode,
  highlightIds,
  jamPeers,
  selectedId,
  readOnly = false,
  labelOf,
  onSelect,
  onChangeNode,
  onChangeGraph,
  onAddNode,
  onReorderContainer,
  onAddContainerStep,
}: Readonly<{
  graph: FlowGraph
  agents: Agent[]
  toolCatalog: ToolCatalog
  dataFields?: DataField[]
  variableNames?: string[]
  statusByNode?: Record<string, StepStatus>
  issuesByNode?: Record<string, NodeIssues>
  highlightIds?: string[]
  jamPeers?: JamPeer[]
  selectedId?: string | null
  readOnly?: boolean
  /** Display label for a node (the builder derives these via stepLabelsOf). */
  labelOf: (node: FlowNode) => string
  onSelect: (id: string | null) => void
  onChangeNode: (node: FlowNode) => void
  /** Structural change (wire added/removed, widget moved). */
  onChangeGraph: (graph: FlowGraph) => void
  onAddNode: (type: StepType, seed: FlowInsertSeed | undefined, position: { x: number; y: number }) => void
  onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void
  onAddContainerStep?: (containerId: string, type: EditableType, branchIndex?: number) => void
}>) {
  // Positions: stored layout wins, dagre fills the rest. Legacy flows (no layout
  // at all) get a full arrangement without persisting anything.
  const layout = useMemo(() => autoLayout(graph), [graph])
  const contained = useMemo(() => containedNodeIds(graph), [graph])
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  const selectedNode = selectedId ? byId.get(selectedId) : undefined
  // A container child is edited in its container's panel, never as a top-level widget.
  const panelNode = selectedNode && !contained.has(selectedNode.id) ? selectedNode : undefined

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
            onOpen: onSelect,
          } satisfies WidgetData as unknown as Record<string, unknown>,
        })),
    [graph.nodes, contained, layout, readOnly, labelOf, statusByNode, issuesByNode, highlightIds, jamPeers, selectedId, onSelect],
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

  // Persist on drag END only — committing every intermediate frame would spam
  // the graph (and Flow Jam) with hundreds of updates per drag.
  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      if (readOnly) return
      onChangeGraph(moveNodeTo(graph, node.id, node.position))
    },
    [graph, readOnly, onChangeGraph],
  )

  const cardProps = useMemo(
    () => ({ agents, toolCatalog, dataFields, variableNames }),
    [agents, toolCatalog, dataFields, variableNames],
  )

  return (
    <div className="flex h-full w-full">
      <div className="min-w-0 flex-1">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onNodeDragStop={onNodeDragStop}
          onPaneClick={() => onSelect(null)}
          nodesConnectable={!readOnly}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
          fitView
        >
          {!readOnly && <AddStepPanel agents={agents} toolCatalog={toolCatalog} onAddNode={onAddNode} />}
          <Background gap={28} size={1} color="rgba(15, 23, 42, 0.22)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-white" />
        </ReactFlow>
      </div>
      {panelNode && (
        <NodeConfigPanel
          node={panelNode}
          graph={graph}
          title={labelOf(panelNode)}
          labelOf={labelOf}
          issuesByNode={issuesByNode}
          readOnly={readOnly}
          cardProps={cardProps}
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
