/**
 * Workato export — recipe JSON.
 *
 * Impedance mismatch, stated up front: a Workato recipe is a TREE (a trigger
 * plus nested `block`s), not a DAG. Fan-in cannot be expressed — several steps
 * converging on one is simply not a shape a recipe can hold.
 *
 * So rather than silently flattening and producing a recipe that looks right but
 * loses the merges, this exports the topological order AND records every lost
 * merge in `description` + per-step notes, so the person finishing the import
 * knows exactly what to rewire. An honest lossy export beats a confident wrong one.
 */
import type { PortableFlow } from './portable'
import type { FlowNode } from '@/lib/flows/graph'
import { topoOrder, parentsOf } from './order'

export type WorkatoRecipe = {
  name: string
  description: string
  version: number
  private: boolean
  code: {
    number: number
    provider: string
    name: string
    as: string
    title: string
    description: string
    keyword: 'trigger' | 'action'
    input: Record<string, unknown>
  }[]
}

const labelOf = (node: FlowNode) => (node.data as { label?: string }).label?.trim() || node.type

/** Our step → the closest Workato connector/action. */
function mapStep(node: FlowNode, triggerBaseUrl?: string): { provider: string; name: string; input: Record<string, unknown> } {
  const data = node.data as Record<string, unknown>
  switch (node.type) {
    case 'http':
      return { provider: 'http', name: 'get', input: { url: String(data.url ?? ''), method: String(data.method ?? 'GET') } }
    case 'agent': {
      const agentId = typeof data.agentId === 'string' ? data.agentId : ''
      if (!triggerBaseUrl || !agentId) break
      // Runnable: calls the live Sublime agent's trigger endpoint.
      return {
        provider: 'http',
        name: 'post',
        input: {
          url: `${triggerBaseUrl}/api/agents/${agentId}/trigger`,
          method: 'POST',
          headers: 'x-trigger-secret: REPLACE_WITH_TRIGGER_SECRET',
          body: '{"input": "..."}',
        },
      }
    }
    case 'condition':
    case 'filter':
      return { provider: 'workato_control', name: 'if', input: {} }
    case 'loop':
    case 'repeatUntil':
      return { provider: 'workato_control', name: 'repeat', input: {} }
    default:
      break
  }
  // tool / everything else (and agents without a trigger URL): no honest
  // Workato equivalent — keep the step visible as a no-op carrying its notes.
  return { provider: 'workato_utils', name: 'noop', input: {} }
}

export function toWorkatoRecipe(portable: PortableFlow, options: { triggerBaseUrl?: string } = {}): WorkatoRecipe {
  const nodes = portable.flow.graph.nodes ?? []
  const edges = portable.flow.graph.edges ?? []
  const order = topoOrder(nodes, edges)
  const parents = parentsOf(edges)
  const nameOf = new Map(nodes.map((node) => [node.id, labelOf(node)]))

  // A recipe is a linear tree: every merge in the DAG is information this format
  // cannot carry. Collect them so the export can say so out loud.
  const lostMerges = order
    .filter((node) => (parents.get(node.id) ?? []).length > 1)
    .map((node) => `"${labelOf(node)}" is fed by ${(parents.get(node.id) ?? []).map((id) => `"${nameOf.get(id) ?? id}"`).join(' + ')}`)

  const code = order.map((node, index) => {
    const mapped = mapStep(node, options.triggerBaseUrl)
    const feeders = parents.get(node.id) ?? []
    const notes: string[] = []
    if (feeders.length > 1) {
      notes.push(`This step merges several inputs (${feeders.map((id) => nameOf.get(id) ?? id).join(', ')}). Workato recipes are linear — recombine these manually.`)
    }
    if (node.type === 'agent') {
      const agent = portable.agents.find((candidate) => candidate.ref === (node.data as { agentId?: string }).agentId)
      const runnable = Boolean(options.triggerBaseUrl)
      notes.push(agent
        ? `AI agent "${agent.title}"${runnable ? ' — this HTTP action runs the live Sublime agent; paste the trigger secret from the agent\u2019s Webhook settings.' : ' — rebuild with an LLM connector.'}\n\n${agent.instructions}`
        : 'AI agent step — definition unavailable at export.')
    }
    if (node.type === 'tool') notes.push('Connect the equivalent Workato connector; credentials are never exported.')
    return {
      number: index + 1,
      provider: mapped.provider,
      name: mapped.name,
      as: node.id,
      title: labelOf(node),
      description: notes.join('\n\n'),
      keyword: (node.type === 'trigger' ? 'trigger' : 'action') as 'trigger' | 'action',
      input: mapped.input,
    }
  })

  const description = [
    portable.flow.description,
    lostMerges.length
      ? `NOTE: Workato recipes are linear, so these merges could not be represented and must be rewired by hand: ${lostMerges.join('; ')}.`
      : '',
    portable.requirements.join(' '),
  ].filter(Boolean).join('\n\n')

  return { name: portable.flow.name || 'Untitled workflow', description, version: 1, private: true, code }
}
