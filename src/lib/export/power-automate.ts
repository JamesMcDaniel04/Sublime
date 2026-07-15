/**
 * Microsoft Power Automate export — a Logic Apps / Flow definition.
 *
 * Better structural fit than Workato: actions carry `runAfter`, which names the
 * actions that must finish first — so this format CAN express fan-in, and our
 * DAG survives. That is the one place Power Automate beats a recipe format.
 *
 * Shape:
 *   { definition: { $schema, contentVersion, triggers: {...},
 *                   actions: { "<name>": { type, inputs, runAfter: { "<dep>": ["Succeeded"] } } } } }
 *
 * Honest mapping: there is no agent equivalent, so an agent step exports as a
 * Compose action carrying its instructions — visible and portable rather than
 * silently dropped.
 */
import type { PortableFlow } from './portable'
import type { FlowNode } from '@/lib/flows/graph'
import { parentsOf } from './order'

type PowerAction = {
  type: string
  inputs: Record<string, unknown>
  runAfter: Record<string, string[]>
  description?: string
}

export type PowerAutomateFlow = {
  definition: {
    $schema: string
    contentVersion: string
    triggers: Record<string, { type: string; inputs?: Record<string, unknown> }>
    actions: Record<string, PowerAction>
    outputs: Record<string, unknown>
  }
  /** Everything the importer must do by hand. */
  notes: string[]
}

const SCHEMA = 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'

const labelOf = (node: FlowNode) => (node.data as { label?: string }).label?.trim() || node.type
/** Power Automate action names can't contain most punctuation. */
const safeName = (label: string) => label.replace(/[^A-Za-z0-9_ ]/g, '').trim().replace(/\s+/g, '_') || 'Step'

function mapAction(node: FlowNode, portable: PortableFlow): { type: string; inputs: Record<string, unknown>; description?: string } {
  const data = node.data as Record<string, unknown>
  switch (node.type) {
    case 'http':
      return { type: 'Http', inputs: { method: String(data.method ?? 'GET'), uri: String(data.url ?? '') }, description: 'Credentials were not exported — add them here.' }
    case 'condition':
    case 'filter':
      return { type: 'If', inputs: {}, description: 'Re-enter the condition — expressions do not translate.' }
    case 'switch':
    case 'router':
      return { type: 'Switch', inputs: {}, description: 'Re-enter the cases.' }
    case 'loop':
      return { type: 'Foreach', inputs: {}, description: 'Steps inside the loop export as separate actions — nest them here.' }
    case 'repeatUntil':
      return { type: 'Until', inputs: {}, description: 'Re-enter the stop condition.' }
    case 'wait':
      return { type: 'Wait', inputs: { interval: { count: Number(data.amount ?? 1), unit: String(data.unit ?? 'Minute') } } }
    case 'agent': {
      const agent = portable.agents.find((candidate) => candidate.ref === (data.agentId as string | undefined))
      return {
        type: 'Compose',
        inputs: { agent: agent?.title ?? 'AI agent', instructions: agent?.instructions ?? '' },
        description: agent
          ? `AI agent "${agent.title}" — Power Automate has no equivalent; replace with an AI Builder / Azure OpenAI action.\n\n${agent.instructions}`
          : 'AI agent step — the agent definition was unavailable at export.',
      }
    }
    case 'tool':
      return { type: 'Compose', inputs: { tool: String(data.toolName ?? '') }, description: 'Connect the equivalent Power Automate connector; credentials are never exported.' }
    default:
      return { type: 'Compose', inputs: {}, description: `"${node.type}" has no direct equivalent — rebuild manually.` }
  }
}

export function toPowerAutomateFlow(portable: PortableFlow): PowerAutomateFlow {
  const nodes = portable.flow.graph.nodes ?? []
  const edges = portable.flow.graph.edges ?? []
  const parents = parentsOf(edges)

  // Unique, Power-Automate-legal action names, keyed by node id.
  const nameById = new Map<string, string>()
  const used = new Set<string>()
  for (const node of nodes) {
    const base = safeName(labelOf(node))
    let name = base
    for (let n = 2; used.has(name); n += 1) name = `${base}_${n}`
    used.add(name)
    nameById.set(node.id, name)
  }

  const triggerNode = nodes.find((node) => node.type === 'trigger')
  const triggers: PowerAutomateFlow['definition']['triggers'] = {
    manual: { type: 'Request', inputs: { schema: {} } },
  }

  const actions: Record<string, PowerAction> = {}
  for (const node of nodes) {
    if (node.type === 'trigger') continue
    const mapped = mapAction(node, portable)
    // runAfter IS the DAG: every feeding action must succeed first, so fan-in
    // survives here (unlike a linear recipe format).
    const runAfter: Record<string, string[]> = {}
    for (const parentId of parents.get(node.id) ?? []) {
      if (triggerNode && parentId === triggerNode.id) continue // trigger deps are implicit
      const parentName = nameById.get(parentId)
      if (parentName) runAfter[parentName] = ['Succeeded']
    }
    actions[nameById.get(node.id)!] = { type: mapped.type, inputs: mapped.inputs, runAfter, ...(mapped.description ? { description: mapped.description } : {}) }
  }

  return {
    definition: { $schema: SCHEMA, contentVersion: '1.0.0.0', triggers, actions, outputs: {} },
    notes: [
      'Imported from Sublime. Action dependencies are expressed with runAfter, so branches and merges are preserved.',
      ...portable.requirements,
    ],
  }
}
