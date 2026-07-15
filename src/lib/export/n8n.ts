/**
 * n8n export — importable workflow JSON.
 *
 * n8n is the closest structural match to our engine: it is a real DAG of
 * `nodes` plus a `connections` map, so fan-out and fan-in survive the trip
 * intact (unlike a linear tool, where a merge has to be faked).
 *
 * Shape (n8n "import from file/clipboard"):
 *   { name, nodes: [{ parameters, id, name, type, typeVersion, position }],
 *     connections: { "<source name>": { main: [ [ { node, type, index } ] ] } } }
 * n8n keys connections by node NAME, not id, so names must be unique.
 *
 * Honest mapping: n8n has no equivalent of our agents. Rather than silently
 * dropping them or pretending an OpenAI node reproduces one, an agent step
 * exports as a NoOp placeholder whose notes carry the full instructions, so the
 * work is visible and portable instead of lost.
 */
import type { PortableFlow } from './portable'
import type { FlowNode } from '@/lib/flows/graph'

type N8nNode = {
  parameters: Record<string, unknown>
  id: string
  name: string
  type: string
  typeVersion: number
  position: [number, number]
  notes?: string
  notesInFlow?: boolean
}

export type N8nWorkflow = {
  name: string
  nodes: N8nNode[]
  connections: Record<string, { main: { node: string; type: 'main'; index: number }[][] }>
  settings: Record<string, unknown>
  meta: { exportedFrom: string; instructions?: string }
}

const labelOf = (node: FlowNode) => (node.data as { label?: string }).label?.trim() || node.type

/** Our step → an n8n node type + parameters. */
function mapNode(node: FlowNode): { type: string; typeVersion: number; parameters: Record<string, unknown>; notes?: string } {
  const data = node.data as Record<string, unknown>
  switch (node.type) {
    case 'trigger':
      return { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }
    case 'http':
      return {
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        parameters: {
          method: String(data.method ?? 'GET'),
          url: String(data.url ?? ''),
          ...(data.body ? { sendBody: true, body: data.body } : {}),
        },
        notes: 'Credentials were not exported — add them in n8n.',
      }
    case 'condition':
    case 'filter':
      return { type: 'n8n-nodes-base.if', typeVersion: 2, parameters: {} , notes: 'Re-enter the condition: expressions do not translate.' }
    case 'switch':
    case 'router':
      return { type: 'n8n-nodes-base.switch', typeVersion: 3, parameters: {}, notes: 'Re-enter the cases.' }
    case 'loop':
    case 'repeatUntil':
      return { type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, parameters: {}, notes: 'Steps inside this loop are exported as separate nodes — rewire them into the loop.' }
    case 'wait':
      return { type: 'n8n-nodes-base.wait', typeVersion: 1.1, parameters: { amount: Number(data.amount ?? 1), unit: String(data.unit ?? 'minutes') } }
    case 'transform':
    case 'data':
      return { type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {}, notes: 'Re-map the fields.' }
    case 'stop':
      return { type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, notes: 'Stop step — n8n ends a branch implicitly.' }
    default:
      // agent / tool / humanReview / subflow / errorShield / parallel / …:
      // no honest n8n equivalent. Keep it visible as a placeholder.
      return { type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} }
  }
}

/** Notes for a step n8n cannot reproduce — the instructions travel with it. */
function placeholderNotes(node: FlowNode, portable: PortableFlow): string | undefined {
  if (node.type === 'agent') {
    const ref = (node.data as { agentId?: string }).agentId
    const agent = portable.agents.find((candidate) => candidate.ref === ref)
    if (!agent) return 'AI agent step — the agent definition was unavailable at export.'
    return [
      `AI agent "${agent.title}" — n8n has no equivalent; rebuild with an AI/LLM node.`,
      agent.model ? `Model: ${agent.model}` : '',
      agent.integrations.length ? `Needs tools: ${agent.integrations.join(', ')}` : '',
      '',
      'Instructions:',
      agent.instructions,
    ].filter(Boolean).join('\n')
  }
  if (node.type === 'tool') {
    return `Tool call "${(node.data as { toolName?: string }).toolName ?? ''}" — connect the equivalent n8n integration; credentials are never exported.`
  }
  if (node.type === 'humanReview') return 'Human approval step — n8n has no direct equivalent; consider a Wait + form/webhook.'
  if (node.type === 'subflow') return 'Runs another workflow — export that workflow too and use n8n Execute Workflow.'
  if (node.type === 'parallel') return 'Parallel branches — in n8n, wire the branches directly off the previous node; they run concurrently.'
  if (node.type === 'errorShield') return 'Error shield — use n8n Error Trigger / node "continue on fail".'
  return undefined
}

/**
 * Convert a portable export to an n8n workflow. Node NAMES are made unique
 * because n8n's `connections` map is keyed by name — duplicates would silently
 * merge two steps' wiring.
 */
export function toN8nWorkflow(portable: PortableFlow): N8nWorkflow {
  const nodes = portable.flow.graph.nodes ?? []
  const edges = portable.flow.graph.edges ?? []
  const layout = portable.flow.graph.layout ?? {}

  const nameById = new Map<string, string>()
  const used = new Set<string>()
  for (const node of nodes) {
    const base = labelOf(node)
    let name = base
    for (let n = 2; used.has(name); n += 1) name = `${base} (${n})`
    used.add(name)
    nameById.set(node.id, name)
  }

  const n8nNodes: N8nNode[] = nodes.map((node, index) => {
    const mapped = mapNode(node)
    const position = layout[node.id]
    const notes = [placeholderNotes(node, portable), mapped.notes].filter(Boolean).join('\n\n') || undefined
    return {
      parameters: mapped.parameters,
      id: node.id,
      name: nameById.get(node.id)!,
      type: mapped.type,
      typeVersion: mapped.typeVersion,
      // Reuse the canvas layout so the imported workflow looks like the original.
      position: [position ? Math.round(position.x) : index * 220, position ? Math.round(position.y) : 0],
      ...(notes ? { notes, notesInFlow: true } : {}),
    }
  })

  // n8n connections: source name → main[outputIndex] → [{ node: target name }].
  // Our DAG maps straight across, which is the whole reason n8n is the best target.
  const connections: N8nWorkflow['connections'] = {}
  for (const edge of edges) {
    const source = nameById.get(edge.source)
    const target = nameById.get(edge.target)
    if (!source || !target) continue
    connections[source] ??= { main: [[]] }
    connections[source].main[0] ??= []
    connections[source].main[0].push({ node: target, type: 'main', index: 0 })
  }

  return {
    name: portable.flow.name || 'Untitled workflow',
    nodes: n8nNodes,
    connections,
    settings: {},
    meta: {
      exportedFrom: 'Sublime',
      ...(portable.requirements.length ? { instructions: portable.requirements.join(' ') } : {}),
    },
  }
}
