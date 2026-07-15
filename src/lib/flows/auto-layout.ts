import dagre from 'dagre'
import type { FlowGraph, FlowLayout } from './graph'

/** Canvas card footprint. Dagre needs a size to reserve space per node. */
export const NODE_WIDTH = 320
export const NODE_HEIGHT = 120
/**
 * Left-to-right, n8n style: the flow reads as a horizontal pipeline, so a fan-in
 * (several APIs converging on one agent) stacks vertically and converges
 * rightward — which is exactly how people draw it on a whiteboard.
 */
const RANK_DIR = 'LR'
/** Gap BETWEEN ranks (horizontal in LR) — generous, wires need room to fan. */
const RANK_SEP = 120
/** Gap between siblings within a rank (vertical in LR). */
const NODE_SEP = 48

/**
 * Node ids owned by a container body (`loop`/`repeatUntil`/`parallel`/
 * `errorShield`). The container renders its own children, so these are never
 * top-level canvas nodes and must not be laid out — mirrors the interpreter's
 * `contained` set.
 */
export function containedNodeIds(graph: FlowGraph): Set<string> {
  return new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' || node.type === 'repeatUntil' ? node.data.body
      : node.type === 'parallel' ? node.data.branches.flat()
      : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
      : [],
    ),
  )
}

/**
 * Positions for every top-level node, laid out LEFT-TO-RIGHT with dagre.
 *
 * Any position already in `graph.layout` WINS — a user's manual placement is
 * never overwritten; only nodes lacking one get computed coordinates. That makes
 * this safe to call on every open: a legacy flow (no layout at all) gets a full
 * sensible arrangement, and a hand-arranged flow is left alone.
 */
export function autoLayout(graph: FlowGraph): FlowLayout {
  const contained = containedNodeIds(graph)
  const topLevel = graph.nodes.filter((node) => !contained.has(node.id))
  if (!topLevel.length) return {}

  const dag = new dagre.graphlib.Graph()
  dag.setGraph({ rankdir: RANK_DIR, ranksep: RANK_SEP, nodesep: NODE_SEP })
  dag.setDefaultEdgeLabel(() => ({}))
  for (const node of topLevel) dag.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })

  const topLevelIds = new Set(topLevel.map((node) => node.id))
  for (const edge of graph.edges) {
    // Edges into/out of container bodies aren't part of the top-level layout.
    if (topLevelIds.has(edge.source) && topLevelIds.has(edge.target)) dag.setEdge(edge.source, edge.target)
  }
  dagre.layout(dag)

  const layout: FlowLayout = {}
  for (const node of topLevel) {
    const existing = graph.layout?.[node.id]
    if (existing) {
      layout[node.id] = existing
      continue
    }
    const placed = dag.node(node.id) as { x?: number; y?: number } | undefined
    // Dagre reports CENTERS; the canvas positions cards by their top-left corner.
    layout[node.id] =
      placed && typeof placed.x === 'number' && typeof placed.y === 'number'
        ? { x: Math.round(placed.x - NODE_WIDTH / 2), y: Math.round(placed.y - NODE_HEIGHT / 2) }
        : { x: 0, y: 0 }
  }
  return layout
}
