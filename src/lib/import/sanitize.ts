/**
 * Post-conversion sanitizer: an imported graph is UNTRUSTED and came from
 * ANOTHER WORKSPACE. Everything that references that workspace — connection
 * row ids, credential vault ids, subflow ids, webhook secrets — is stripped
 * or cleared here, with a human-readable warning per removal. Portable
 * connection ids (nango:/native:/template:) are the documented exception
 * (see src/lib/flows/starter-templates.ts).
 */
import type { FlowGraph } from '@/lib/flows/graph'

const PORTABLE_CONNECTION_ID = /^(nango:|native:|template:)/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function labelOf(node: FlowGraph['nodes'][number]): string {
  const data = node.data as { label?: string }
  return data.label?.trim() || node.type
}

/** First occurrence keeps its id; later collisions get a numeric suffix. */
function dedupeNodeIds(graph: FlowGraph): void {
  const seen = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id || seen.has(node.id)) {
      const base = node.id || 'step'
      let next = base
      for (let n = 2; seen.has(next) || !next; n += 1) next = `${base}-${n}`
      node.id = next
    }
    seen.add(node.id)
  }
}

/** Rename node `from` to `to` and follow every edge + layout entry. */
function renameNode(graph: FlowGraph, from: string, to: string): void {
  for (const node of graph.nodes) if (node.id === from) node.id = to
  for (const edge of graph.edges) {
    if (edge.source === from) edge.source = to
    if (edge.target === from) edge.target = to
  }
  if (graph.layout && graph.layout[from]) {
    graph.layout[to] = graph.layout[from]
    delete graph.layout[from]
  }
}

export function sanitizeImportedGraph(input: FlowGraph): { graph: FlowGraph; warnings: string[] } {
  const graph: FlowGraph = JSON.parse(JSON.stringify(input))
  const warnings: string[] = []

  dedupeNodeIds(graph)

  // Exactly one trigger, with id 'trigger' (validateFlowGraph requires it).
  const triggers = graph.nodes.filter((node) => node.type === 'trigger')
  for (const extra of triggers.slice(1)) {
    graph.nodes = graph.nodes.filter((node) => node !== extra)
    graph.edges = graph.edges.filter((edge) => edge.source !== extra.id && edge.target !== extra.id)
    warnings.push('The import had more than one trigger — only the first was kept.')
  }
  const trigger = triggers[0]
  if (trigger && trigger.id !== 'trigger') {
    // A non-trigger node may already hold the name; move it out of the way first.
    if (graph.nodes.some((node) => node !== trigger && node.id === 'trigger')) {
      renameNode(graph, 'trigger', 'trigger-step')
    }
    renameNode(graph, trigger.id, 'trigger')
  }

  for (const node of graph.nodes) {
    if (node.type === 'trigger' && isRecord(node.data.trigger)) {
      // Never resurrect a foreign webhook secret — a fresh one is minted at publish.
      delete node.data.trigger.webhookSecretHash
      delete node.data.trigger.webhookSecretEnc
    }
    if (node.type === 'tool' && node.data.connectionId && !PORTABLE_CONNECTION_ID.test(node.data.connectionId)) {
      node.data.connectionId = ''
      warnings.push(`"${labelOf(node)}" referenced a connection from another workspace — pick one of yours.`)
    }
    if (node.type === 'http') {
      if (node.data.credentialId) {
        delete node.data.credentialId
        warnings.push(`"${labelOf(node)}" referenced a credential from another workspace — re-select or re-create it.`)
      }
      if (node.data.connectionId && !PORTABLE_CONNECTION_ID.test(node.data.connectionId)) {
        delete node.data.connectionId
        warnings.push(`"${labelOf(node)}" referenced a connection from another workspace — pick one of yours.`)
      }
    }
    if (node.type === 'subflow' && node.data.flowId) {
      node.data.flowId = ''
      warnings.push(`"${labelOf(node)}" ran another flow that does not exist here — choose one of your flows.`)
    }
  }

  return { graph, warnings }
}

/**
 * Replace portable agent refs with the ids of agents materialized in THIS
 * workspace. Unmapped non-empty refs are cleared (a dangling foreign agentId
 * would fail validation as UNKNOWN_AGENT) and returned so the route can warn.
 */
export function remapAgentRefs(
  input: FlowGraph,
  refToId: Record<string, string>,
): { graph: FlowGraph; clearedRefs: string[] } {
  const graph: FlowGraph = JSON.parse(JSON.stringify(input))
  const clearedRefs: string[] = []
  for (const node of graph.nodes) {
    if (node.type !== 'agent' || !node.data.agentId) continue
    const mapped = refToId[node.data.agentId]
    if (mapped) node.data.agentId = mapped
    else {
      clearedRefs.push(node.data.agentId)
      node.data.agentId = ''
    }
  }
  return { graph, clearedRefs }
}
