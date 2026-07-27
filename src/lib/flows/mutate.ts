import { flowNodeSchema, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { CODE_SNIPPETS } from './code-snippets'

/** Node types a user can create as a step (everything but the trigger). */
export type StepType = Exclude<FlowNode['type'], 'trigger'>

/** Generate a node id not already used in the graph. */
function newNodeId(graph: FlowGraph, prefix = 'n'): string {
  const ids = new Set(graph.nodes.map((node) => node.id))
  let index = graph.nodes.length + 1
  while (ids.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
}

function edgeId(source: string, target: string, branch?: string): string {
  return `${source}->${target}${branch ? `:${branch}` : ''}`
}

/** Default `data` for a freshly created / retyped node. */
function defaultData(type: FlowNode['type'], extra?: { bodyId?: string; agentId?: string }): FlowNode['data'] {
  switch (type) {
    case 'agent':
      return { agentId: extra?.agentId ?? '', input: 'Use this flow input:\n{{trigger.input}}' }
    case 'condition':
      return { match: 'all', clauses: [{ left: '', op: 'contains', right: '' }] }
    case 'loop':
      return { over: '{{trigger.input}}', concurrency: 3, body: extra?.bodyId ? [extra.bodyId] : [] }
    case 'parallel':
      return { branches: extra?.bodyId ? [[extra.bodyId]] : [] }
    case 'stop':
      return { reason: '' }
    case 'tool':
      return { connectionId: '', toolName: '', args: '{}' }
    case 'http':
      return {
        method: 'POST',
        url: '',
        authMode: 'none',
        sendQuery: false,
        sendHeaders: false,
        sendBody: false,
        bodyMode: 'json',
        responseType: 'auto',
        failOnHttpError: true,
        retries: 0,
        body: '',
      }
    case 'respondWebhook':
      return { statusCode: 200, bodyMode: 'json', body: '{{trigger.input}}' }
    case 'wait':
      return { amount: 1, unit: 'seconds' }
    case 'repeatUntil':
      return { body: extra?.bodyId ? [extra.bodyId] : [], clauses: [], match: 'all', maxIterations: 20, delayMs: 1000 }
    case 'code':
      // A fresh node opens with the runnable JS starter, like n8n's.
      return { language: 'javascript', mode: 'allItems', code: CODE_SNIPPETS.javascript.allItems }
    case 'transform':
      return { fields: [{ name: '', value: '' }] }
    case 'filter':
      return { match: 'all', clauses: [{ left: '', op: 'contains', right: '' }] }
    case 'switch':
      return { cases: [{ id: 'case1', left: '', op: 'contains', right: '' }] }
    case 'variable':
      return { op: 'initialize', name: '', varType: 'string', value: '' }
    case 'data':
      return { op: 'compose', input: '' }
    case 'humanReview':
      return { message: '' }
    case 'input':
      return { params: [] }
    case 'output':
      return { fields: [] }
    case 'subflow':
      return { flowId: '' }
    case 'router':
      return { input: '{{trigger.input}}', branches: [{ id: 'branch1', label: '' }] }
    case 'errorShield':
      return { body: extra?.bodyId ? [extra.bodyId] : [], fallback: [] }
    case 'trigger':
      return { trigger: { type: 'manual' } }
  }
}

function makeNode(graph: FlowGraph, type: StepType, agentId?: string): { node: FlowNode; extraNodes: FlowNode[] } {
  const id = newNodeId(graph)
  // Containers are born with one agent body step so they are runnable.
  if (type === 'loop' || type === 'parallel' || type === 'errorShield' || type === 'repeatUntil') {
    const bodyId = `${id}b1`
    const body = {
      id: bodyId,
      type: 'agent',
      data: {
        agentId: agentId ?? '',
        input: type === 'loop' ? 'Process this item:\n{{item}}' : 'Use this flow input:\n{{trigger.input}}',
      },
    } as FlowNode
    return { node: { id, type, data: defaultData(type, { bodyId }) } as FlowNode, extraNodes: [body] }
  }
  return { node: { id, type, data: defaultData(type, { agentId }) } as FlowNode, extraNodes: [] }
}

/** Insert a new step of any type immediately after `afterId`, healing the chain. */
export function insertNodeAfter(graph: FlowGraph, afterId: string, type: StepType, agentId?: string): { graph: FlowGraph; nodeId: string } {
  const { node, extraNodes } = makeNode(graph, type, agentId)
  const edges = [...graph.edges]
  // Reconnect afterId's primary outgoing edge through the new node.
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(node.id, old.target), source: node.id, target: old.target }
  }
  edges.push({ id: edgeId(afterId, node.id), source: afterId, target: node.id })
  return { graph: { nodes: [...graph.nodes, node, ...extraNodes], edges }, nodeId: node.id }
}

/** Back-compat helper used by earlier tests: insert an agent step. */
export function insertAgentAfter(graph: FlowGraph, afterId: string, agentId: string): { graph: FlowGraph; nodeId: string } {
  return insertNodeAfter(graph, afterId, 'agent', agentId)
}

// ── Free-form DAG canvas mutations ──────────────────────────────────────────

/**
 * Would wiring `source → target` close a loop? True iff `source` is ALREADY
 * reachable from `target` (or they're the same node). The DAG engine rejects
 * cycles at run time; the canvas uses this to refuse the connection up front,
 * which is a far better experience than a failed run.
 */
export function wouldCreateCycle(graph: FlowGraph, source: string, target: string): boolean {
  if (source === target) return true
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length) {
    const id = stack.pop()!
    if (id === source) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const edge of graph.edges) if (edge.source === id) stack.push(edge.target)
  }
  return false
}

/**
 * Wire one node into another (the canvas's drag port→port). Refuses self-links,
 * duplicates, and anything that would create a cycle. Many→many is the point:
 * a node may have any number of parents and children.
 */
export function connectNodes(
  graph: FlowGraph,
  source: string,
  target: string,
  branch?: string,
): { graph: FlowGraph } | { error: string } {
  if (source === target) return { error: "A step can't connect to itself." }
  if (!graph.nodes.some((node) => node.id === source) || !graph.nodes.some((node) => node.id === target)) {
    return { error: 'That step no longer exists.' }
  }
  if (graph.edges.some((edge) => edge.source === source && edge.target === target && edge.branch === branch)) {
    return { error: 'Those steps are already connected.' }
  }
  if (wouldCreateCycle(graph, source, target)) {
    return { error: 'That connection would loop back on itself. Flows run forward — use a Loop step to repeat work.' }
  }
  const edge = { id: edgeId(source, target, branch), source, target, ...(branch ? { branch } : {}) }
  return { graph: { ...graph, edges: [...graph.edges, edge] } }
}

/** Remove a single wire, leaving both nodes in place. */
export function disconnectEdge(graph: FlowGraph, id: string): FlowGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== id) }
}

/** Record a node's canvas position (layout is a view concern — see flowLayoutSchema). */
export function moveNodeTo(graph: FlowGraph, id: string, position: { x: number; y: number }): FlowGraph {
  return { ...graph, layout: { ...(graph.layout ?? {}), [id]: { x: Math.round(position.x), y: Math.round(position.y) } } }
}

/**
 * Drop a standalone step onto the canvas at `position`. Deliberately creates NO
 * edges — on a free-form canvas the user wires it themselves, which is the whole
 * point (contrast `insertNodeAfter`, which splices into a chain).
 */
export function addNodeAt(
  graph: FlowGraph,
  type: StepType,
  position: { x: number; y: number },
  agentId?: string,
): { graph: FlowGraph; nodeId: string } {
  const { node, extraNodes } = makeNode(graph, type, agentId)
  return {
    graph: {
      ...graph,
      nodes: [...graph.nodes, node, ...extraNodes],
      layout: { ...(graph.layout ?? {}), [node.id]: { x: Math.round(position.x), y: Math.round(position.y) } },
    },
    nodeId: node.id,
  }
}

/**
 * Quick-add (the per-node "+" and drag-to-canvas gestures): drop a step at
 * `position` AND wire it from `sourceId` in one mutation. Fan-out by design —
 * existing outgoing wires are kept, never spliced (contrast insertNodeAfter).
 * A vanished source (a Jam peer deleted it mid-gesture) degrades to addNodeAt.
 *
 * `branch` labels the wire with a branch-node output (condition true/false,
 * switch/router case id or 'default') — the engine only follows a PLAIN edge
 * from a branch node as a fallback, so quick-adds from those nodes must name
 * the output or the new step may never run.
 */
export function addConnectedNodeAt(
  graph: FlowGraph,
  sourceId: string,
  type: StepType,
  position: { x: number; y: number },
  agentId?: string,
  branch?: string,
): { graph: FlowGraph; nodeId: string } {
  const added = addNodeAt(graph, type, position, agentId)
  if (!graph.nodes.some((node) => node.id === sourceId)) return added
  const edge = { id: edgeId(sourceId, added.nodeId, branch), source: sourceId, target: added.nodeId, ...(branch ? { branch } : {}) }
  return { graph: { ...added.graph, edges: [...added.graph.edges, edge] }, nodeId: added.nodeId }
}

/**
 * Append a step to a condition's true/false branch: at the tail of the existing
 * branch chain, or as the branch's first node when the branch is empty.
 */
export function appendToBranch(graph: FlowGraph, conditionId: string, branch: string, type: StepType, agentId?: string): { graph: FlowGraph; nodeId: string } {
  const head = graph.edges.find((edge) => edge.source === conditionId && edge.branch === branch)
  if (!head) {
    const { node, extraNodes } = makeNode(graph, type, agentId)
    return {
      graph: {
        nodes: [...graph.nodes, node, ...extraNodes],
        edges: [...graph.edges, { id: edgeId(conditionId, node.id, branch), source: conditionId, target: node.id, branch }],
      },
      nodeId: node.id,
    }
  }
  // Walk to the branch tail (cycle-guarded), then do a plain insert after it.
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  let tail = head.target
  while (!seen.has(tail)) {
    seen.add(tail)
    const next = graph.edges.find((edge) => edge.source === tail && !edge.branch)
    if (!next || !byId.has(next.target)) break
    tail = next.target
  }
  return insertNodeAfter(graph, tail, type, agentId)
}

/** Replace a node (matched by id) with an updated version. */
export function updateNode(graph: FlowGraph, updated: FlowNode): FlowGraph {
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === updated.id ? updated : node)) }
}

/** Append a new typed step to a container. For an Error Shield, branchIndex
 *  -1 targets the fallback list; the default targets its protected body. */
export function addContainerStep(graph: FlowGraph, containerId: string, type: StepType = 'agent', agentId?: string, branchIndex?: number): { graph: FlowGraph; nodeId: string } {
  const container = graph.nodes.find((n) => n.id === containerId)
  const isLoop = container?.type === 'loop'
  const { node, extraNodes } = makeNode(graph, type, agentId)
  const bodyNode =
    node.type === 'agent' && isLoop
      ? ({ ...node, data: { ...node.data, input: 'Process this item:\n{{item}}' } } as FlowNode)
      : node
  const nodes = graph.nodes.map((node) => {
    if (node.id !== containerId) return node
    if (node.type === 'loop') return { ...node, data: { ...node.data, body: [...node.data.body, bodyNode.id] } }
    if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: [...node.data.branches, [bodyNode.id]] } }
    if (node.type === 'errorShield') {
      return branchIndex === -1
        ? { ...node, data: { ...node.data, fallback: [...node.data.fallback, bodyNode.id] } }
        : { ...node, data: { ...node.data, body: [...node.data.body, bodyNode.id] } }
    }
    if (node.type === 'repeatUntil') return { ...node, data: { ...node.data, body: [...node.data.body, bodyNode.id] } }
    return node
  })
  return { graph: { ...graph, nodes: [...nodes, bodyNode, ...extraNodes] }, nodeId: bodyNode.id }
}

/** Locate the container list holding `id`: which container node, which branch
 *  (for parallel), and the index within that list. Null for main-chain ids. */
function containerPositionOf(graph: FlowGraph, id: string): { containerId: string; branchIndex?: number; index: number } | null {
  for (const node of graph.nodes) {
    if (node.type === 'loop') {
      const index = node.data.body.indexOf(id)
      if (index >= 0) return { containerId: node.id, index }
    }
    if (node.type === 'parallel') {
      for (let branchIndex = 0; branchIndex < node.data.branches.length; branchIndex += 1) {
        const index = node.data.branches[branchIndex].indexOf(id)
        if (index >= 0) return { containerId: node.id, branchIndex, index }
      }
    }
    if (node.type === 'errorShield') {
      const b = node.data.body.indexOf(id)
      if (b >= 0) return { containerId: node.id, index: b }
      const f = node.data.fallback.indexOf(id)
      if (f >= 0) return { containerId: node.id, branchIndex: -1, index: f } // -1 marks the fallback list
    }
    if (node.type === 'repeatUntil') {
      const index = node.data.body.indexOf(id)
      if (index >= 0) return { containerId: node.id, index }
    }
  }
  return null
}

/** Insert `insertedId` into the container list right after `position`. */
function insertIntoContainer(graph: FlowGraph, position: { containerId: string; branchIndex?: number; index: number }, insertedId: string): FlowNode[] {
  return graph.nodes.map((entry) => {
    if (entry.id !== position.containerId) return entry
    if (entry.type === 'loop') {
      const body = [...entry.data.body]
      body.splice(position.index + 1, 0, insertedId)
      return { ...entry, data: { ...entry.data, body } }
    }
    if (entry.type === 'repeatUntil') {
      const body = [...entry.data.body]
      body.splice(position.index + 1, 0, insertedId)
      return { ...entry, data: { ...entry.data, body } }
    }
    if (entry.type === 'parallel' && position.branchIndex !== undefined) {
      const branches = entry.data.branches.map((branch, i) => {
        if (i !== position.branchIndex) return branch
        const next = [...branch]
        next.splice(position.index + 1, 0, insertedId)
        return next
      })
      return { ...entry, data: { ...entry.data, branches } }
    }
    if (entry.type === 'errorShield') {
      const list = position.branchIndex === -1 ? [...entry.data.fallback] : [...entry.data.body]
      list.splice(position.index + 1, 0, insertedId)
      return position.branchIndex === -1
        ? { ...entry, data: { ...entry.data, fallback: list } }
        : { ...entry, data: { ...entry.data, body: list } }
    }
    return entry
  })
}

/** Duplicate a step in place: the copy is inserted right after the original. */
export function duplicateNode(graph: FlowGraph, id: string): { graph: FlowGraph; nodeId: string } {
  const original = graph.nodes.find((node) => node.id === id)
  if (!original || original.type === 'trigger') return { graph, nodeId: id }
  const copyId = newNodeId(graph)
  const copy = { id: copyId, type: original.type, data: JSON.parse(JSON.stringify(original.data)) } as FlowNode
  // Containers duplicate shallowly (fresh empty body) — bodies keep their ids
  // and must not be shared between two containers.
  if (copy.type === 'loop') copy.data = { ...copy.data, body: [] }
  if (copy.type === 'repeatUntil') copy.data = { ...copy.data, body: [] }
  if (copy.type === 'parallel') copy.data = { ...copy.data, branches: [] }
  if (copy.type === 'errorShield') copy.data = { ...copy.data, body: [], fallback: [] }
  const position = containerPositionOf(graph, id)
  if (position) {
    const nodes = insertIntoContainer(graph, position, copyId)
    return { graph: { nodes: [...nodes, copy], edges: graph.edges }, nodeId: copyId }
  }
  const edges = [...graph.edges]
  const idx = edges.findIndex((edge) => edge.source === id && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(copyId, old.target), source: copyId, target: old.target }
  }
  edges.push({ id: edgeId(id, copyId), source: id, target: copyId })
  return { graph: { nodes: [...graph.nodes, copy], edges }, nodeId: copyId }
}

/**
 * Delete a node, healing around it: EVERY predecessor connects to EVERY plain
 * successor (a DAG node may have several of each — dropping any pairing would
 * silently sever a fan-in/fan-out path). Incoming branch flags are preserved
 * (so deleting the first node of a condition branch keeps the branch wired),
 * and a pairing that already exists as a direct wire is not duplicated.
 */
export function deleteNode(graph: FlowGraph, id: string): FlowGraph {
  if (id === 'trigger') return graph
  const incoming = graph.edges.filter((edge) => edge.target === id)
  const outgoing = graph.edges.filter((edge) => edge.source === id && !edge.branch)
  const edges = graph.edges.filter((edge) => edge.source !== id && edge.target !== id)
  for (const inEdge of incoming) {
    for (const outEdge of outgoing) {
      if (inEdge.source === outEdge.target) continue // healing must not mint a self-loop
      if (edges.some((edge) => edge.source === inEdge.source && edge.target === outEdge.target && edge.branch === inEdge.branch)) continue
      edges.push({ id: edgeId(inEdge.source, outEdge.target, inEdge.branch), source: inEdge.source, target: outEdge.target, ...(inEdge.branch ? { branch: inEdge.branch } : {}) })
    }
  }
  const nodes = graph.nodes
    .filter((node) => node.id !== id)
    // Purge the id from any loop body / parallel branches that referenced it.
    .map((node) => {
      if (node.type === 'loop') return { ...node, data: { ...node.data, body: node.data.body.filter((b) => b !== id) } }
      if (node.type === 'repeatUntil') return { ...node, data: { ...node.data, body: node.data.body.filter((b) => b !== id) } }
      if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: node.data.branches.map((br) => br.filter((b) => b !== id)) } }
      if (node.type === 'errorShield') return { ...node, data: { ...node.data, body: node.data.body.filter((b) => b !== id), fallback: node.data.fallback.filter((b) => b !== id) } }
      return node
    })
  return { nodes, edges }
}

/** Ids living inside a container node's own subtree (its body/branch steps). */
function containedIdsOf(node: FlowNode): string[] {
  if (node.type === 'loop') return node.data.body
  if (node.type === 'repeatUntil') return node.data.body
  if (node.type === 'parallel') return node.data.branches.flat()
  if (node.type === 'errorShield') return [...node.data.body, ...node.data.fallback]
  return []
}

/** Every node id reachable inside `node`'s own subtree: container body/branch
 *  steps (recursively) plus branch-edge chains hanging off condition/switch
 *  descendants. Used to block dropping a node into itself. */
function subtreeIdsOf(graph: FlowGraph, rootId: string): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const out = new Set<string>()
  const queue = [rootId]
  while (queue.length) {
    const id = queue.pop()!
    const node = byId.get(id)
    if (!node) continue
    for (const child of containedIdsOf(node)) {
      if (!out.has(child)) {
        out.add(child)
        queue.push(child)
      }
    }
    // Branch-edge children (condition/switch heads) and their plain chains.
    for (const edge of graph.edges) {
      if (edge.source !== id) continue
      if (id === rootId && !edge.branch) continue // the root's main-chain successor is NOT its subtree
      if (!out.has(edge.target)) {
        out.add(edge.target)
        queue.push(edge.target)
      }
    }
  }
  return out
}

/**
 * Move an existing step so it sits immediately after `afterId`, healing both
 * the old and new positions. Container bodies are NOT movable this way — use
 * moveContainerStep. No-op on any invalid move.
 *
 * Condition/switch nodes anchor their subtrees (they have only branch-tagged
 * outgoing edges, never a plain successor) and cannot be relocated by this
 * operation — moving one would sever the chain and orphan its branches.
 */
export function moveNodeAfter(graph: FlowGraph, nodeId: string, afterId: string): FlowGraph {
  if (nodeId === afterId || nodeId === 'trigger') return graph
  const node = graph.nodes.find((n) => n.id === nodeId)
  const target = graph.nodes.find((n) => n.id === afterId)
  if (!node || !target) return graph
  if (node.type === 'condition' || node.type === 'switch') return graph
  if (subtreeIdsOf(graph, nodeId).has(afterId)) return graph
  // A step referenced by any container's body/branches moves via the array API.
  const contained = new Set(graph.nodes.flatMap(containedIdsOf))
  if (contained.has(nodeId)) return graph

  // 1) Detach: heal the chain around the node (deleteNode's edge logic, node kept).
  const incoming = graph.edges.find((edge) => edge.target === nodeId)
  const outgoing = graph.edges.find((edge) => edge.source === nodeId && !edge.branch)
  // Condition/switch nodes are blocked above, so a moved node never owns branch
  // edges here — no need to re-collect/re-append them.
  const edges = graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
  if (incoming && outgoing) {
    edges.push({
      id: edgeId(incoming.source, outgoing.target, incoming.branch),
      source: incoming.source,
      target: outgoing.target,
      ...(incoming.branch ? { branch: incoming.branch } : {}),
    })
  }

  // 2) Splice after the target (insertNodeAfter's edge logic, existing node).
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(nodeId, old.target), source: nodeId, target: old.target }
  }
  edges.push({ id: edgeId(afterId, nodeId), source: afterId, target: nodeId })
  return { ...graph, edges }
}

/** Reorder a loop body (or one parallel branch) by index. Out-of-range no-ops. */
export function moveContainerStep(graph: FlowGraph, containerId: string, from: number, to: number, branchIndex?: number): FlowGraph {
  const container = graph.nodes.find((n) => n.id === containerId)
  if (!container) return graph
  const reorder = (list: string[]): string[] | null => {
    if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return null
    const next = [...list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  }
  if (container.type === 'loop') {
    const next = reorder(container.data.body)
    if (!next) return graph
    return updateNode(graph, { ...container, data: { ...container.data, body: next } })
  }
  if (container.type === 'repeatUntil') {
    const next = reorder(container.data.body)
    if (!next) return graph
    return updateNode(graph, { ...container, data: { ...container.data, body: next } })
  }
  if (container.type === 'parallel' && branchIndex !== undefined) {
    const branch = container.data.branches[branchIndex]
    if (!branch) return graph
    const next = reorder(branch)
    if (!next) return graph
    const branches = container.data.branches.map((b, i) => (i === branchIndex ? next : b))
    return updateNode(graph, { ...container, data: { ...container.data, branches } })
  }
  return graph
}

/** Validate clipboard content into a paste-safe step (never a trigger; containers emptied). */
export function sanitizeCopiedNode(raw: unknown): FlowNode | null {
  const parsed = flowNodeSchema.safeParse(raw)
  if (!parsed.success || parsed.data.type === 'trigger') return null
  const node = parsed.data
  if (node.type === 'loop') return { ...node, data: { ...node.data, body: [] } }
  if (node.type === 'repeatUntil') return { ...node, data: { ...node.data, body: [] } }
  if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: [] } }
  if (node.type === 'errorShield') return { ...node, data: { ...node.data, body: [], fallback: [] } }
  return node
}

/** Paste a sanitized copied step immediately after `afterId` with a fresh id. */
export function pasteNodeAfter(graph: FlowGraph, afterId: string, copied: FlowNode): { graph: FlowGraph; nodeId: string } {
  const copyId = newNodeId(graph)
  const copy = { id: copyId, type: copied.type, data: JSON.parse(JSON.stringify(copied.data)) } as FlowNode
  const position = containerPositionOf(graph, afterId)
  if (position) {
    const nodes = insertIntoContainer(graph, position, copyId)
    return { graph: { nodes: [...nodes, copy], edges: graph.edges }, nodeId: copyId }
  }
  const edges = [...graph.edges]
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(copyId, old.target), source: copyId, target: old.target }
  }
  edges.push({ id: edgeId(afterId, copyId), source: afterId, target: copyId })
  return { graph: { nodes: [...graph.nodes, copy], edges }, nodeId: copyId }
}
