'use client'

/**
 * Free-form DAG canvas (sub-project ②) — the builder surface for the DAG engine.
 *
 * The old canvas renders a vertical stack, so a graph could only ever be a
 * chain. Here every top-level node is a positioned card with a target handle on
 * top and a source handle on the bottom, so a user can wire many→many: three
 * APIs into one agent, or one API into three agents. The engine already executes
 * exactly this shape (fan-out, wait-for-all joins, edge-scoped context).
 *
 * Layout lives in `graph.layout` (a view concern, keyed by node id). A graph
 * with no layout — every flow authored before this — is auto-laid-out with dagre
 * on open; nothing is persisted until the user actually drags something.
 *
 * Container-body nodes (loop/parallel/errorShield children) are NOT top-level
 * cards — their container owns them, mirroring the interpreter's `contained`
 * set — so a container card renders its children nested inside itself.
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
import '@xyflow/react/dist/style.css'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { StepCard, type StepStatus } from './step-card'
import { FlowPicker } from './flow-picker'
import type { FlowInsertSeed } from './flow-canvas'
import type { ToolCatalog } from './tool-catalog-type'
import { NODE_WIDTH, autoLayout, containedNodeIds } from '@/lib/flows/auto-layout'
import { connectNodes, disconnectEdge, moveNodeTo, type StepType } from '@/lib/flows/mutate'
import type { DataField } from '@/lib/flows/datatree'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import type { JamPeer } from './use-flow-jam'

type Agent = { id: string; title: string }
type NodeIssues = { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }

/** The child ids a container owns — mirrors auto-layout/interpreter `contained`. */
function containerChildIds(node: FlowNode): string[] {
  return node.type === 'loop' || node.type === 'repeatUntil' ? node.data.body
    : node.type === 'parallel' ? node.data.branches.flat()
    : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
    : []
}

/** Everything a hosted StepCard needs, carried on the React Flow node. */
type StepNodeData = {
  node: FlowNode
  title: string
  status?: StepStatus
  issues?: NodeIssues
  highlighted: boolean
  selected: boolean
  jamEditors: JamPeer[]
  /** Resolved container children, rendered nested inside this card. */
  children: { node: FlowNode; title: string; issues?: NodeIssues }[]
  agents: Agent[]
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  variableNames: string[]
  readOnly: boolean
  onChange: (node: FlowNode) => void
  onSelect: (id: string) => void
}

/**
 * A single card on the canvas. The handles ARE the DAG: dragging bottom→top
 * creates an edge, which is both an execution dependency and a data path.
 */
function StepFlowNode({ data }: Readonly<NodeProps>) {
  const step = data as unknown as StepNodeData
  const cardProps = {
    agents: step.agents,
    toolCatalog: step.toolCatalog,
    dataFields: step.dataFields,
    labelCtx: {} as never,
    variableNames: step.variableNames,
  }
  return (
    <div style={{ width: NODE_WIDTH }} className="relative">
      {/* Trigger has no parents, so it exposes no inbound handle. */}
      {step.node.type !== 'trigger' && (
        <Handle type="target" position={Position.Top} className="!h-3 !w-3 !border-2 !border-white !bg-slate-400 hover:!bg-blue-500" />
      )}
      <StepCard
        {...cardProps}
        node={step.node}
        title={step.title}
        status={step.status}
        issues={step.issues}
        highlighted={step.highlighted}
        selected={step.selected}
        jamEditors={step.jamEditors}
        onChange={step.readOnly ? () => {} : step.onChange}
        onClick={() => step.onSelect(step.node.id)}
      />
      {/* Container children live INSIDE their container (the DAG never sees them
          as top-level nodes). Editing works; reordering stays in Stack view. */}
      {step.children.length > 0 && (
        <div className="mt-2 space-y-2 rounded-2xl border border-dashed border-slate-300 bg-white/70 p-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Inside this step</p>
          {step.children.map((child) => (
            <StepCard
              key={child.node.id}
              {...cardProps}
              node={child.node}
              title={child.title}
              issues={child.issues}
              selected={false}
              onChange={step.readOnly ? () => {} : step.onChange}
              onClick={() => step.onSelect(child.node.id)}
            />
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!h-3 !w-3 !border-2 !border-white !bg-slate-400 hover:!bg-blue-500" />
    </div>
  )
}

// Stable identity — React Flow re-mounts every node if this object changes.
const nodeTypes = { step: StepFlowNode }

/**
 * "Add step" for the canvas. Lives inside <ReactFlow> so it can use
 * `screenToFlowPosition` to drop the new card where the user is actually
 * looking, rather than at an arbitrary origin.
 */
function AddStepPanel({
  agents,
  toolCatalog,
  onAddNode,
}: {
  agents: Agent[]
  toolCatalog: ToolCatalog
  onAddNode: (type: StepType, seed: FlowInsertSeed | undefined, position: { x: number; y: number }) => void
}) {
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
                // Drop it in the middle of what the user is looking at.
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
}: {
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
  /** Structural change (wire added/removed, card moved). */
  onChangeGraph: (graph: FlowGraph) => void
  onAddNode: (type: StepType, seed: FlowInsertSeed | undefined, position: { x: number; y: number }) => void
}) {
  // Positions: stored layout wins, dagre fills the rest. Legacy flows (no layout
  // at all) get a full arrangement without persisting anything.
  const layout = useMemo(() => autoLayout(graph), [graph])
  const contained = useMemo(() => containedNodeIds(graph), [graph])
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])

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
            children: containerChildIds(node)
              .map((id) => byId.get(id))
              .filter((child): child is FlowNode => Boolean(child))
              .map((child) => ({ node: child, title: labelOf(child), issues: issuesByNode?.[child.id] })),
            agents,
            toolCatalog,
            dataFields,
            variableNames,
            readOnly,
            onChange: onChangeNode,
            onSelect,
          } satisfies StepNodeData as unknown as Record<string, unknown>,
        })),
    [graph.nodes, contained, byId, layout, readOnly, labelOf, statusByNode, issuesByNode, highlightIds, jamPeers, selectedId, agents, toolCatalog, dataFields, variableNames, onChangeNode, onSelect],
  )

  const rfEdges: Edge[] = useMemo(
    () =>
      graph.edges
        // A wire is only drawable when both ends are top-level cards.
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

  return (
    <div className="h-full w-full">
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
  )
}
