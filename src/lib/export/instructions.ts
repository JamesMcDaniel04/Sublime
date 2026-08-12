/**
 * Instructions export — a human/LLM-readable rebuild spec.
 *
 * This is the universal target: it works for every platform, including the ones
 * with no import API at all (Zapier). Rather than pretending a one-click import
 * exists, this describes the flow precisely enough that a person — or an LLM
 * pasted into another builder — can reconstruct it.
 *
 * It leans on the DAG: because each step lists the steps that FEED it, the
 * document conveys fan-in/fan-out, which a linear "step 1, step 2" list cannot.
 */
import type { PortableAgentDoc, PortableFlow } from './portable'
import type { FlowNode } from '@/lib/flows/graph'

const TYPE_PROSE: Record<string, string> = {
  trigger: 'Starts the workflow',
  agent: 'Runs an AI agent',
  tool: 'Calls a tool on a connected integration',
  http: 'Makes an HTTP request to an API',
  transform: 'Sets/reshapes fields',
  data: 'Performs a data operation',
  condition: 'Branches on a condition (if/else)',
  switch: 'Branches on the first matching case',
  router: 'Uses an AI model to pick a branch',
  filter: 'Continues only when the condition passes',
  loop: 'Repeats the steps inside it for each item',
  repeatUntil: 'Repeats the steps inside it until a condition holds',
  parallel: 'Runs its branches at the same time',
  errorShield: 'Runs its body, falling back if it fails',
  humanReview: 'Pauses and asks a person',
  wait: 'Waits before continuing',
  variable: 'Reads/writes a workflow variable',
  subflow: 'Runs another workflow',
  stop: 'Stops the workflow',
  input: 'Declares the workflow inputs',
  output: 'Declares the workflow output',
  respondWebhook: 'Responds to the incoming webhook',
}

const labelOf = (node: FlowNode) => (node.data as { label?: string }).label?.trim() || node.type

/** A one-line summary of what a step is actually configured to do. */
function detailOf(node: FlowNode): string | null {
  const data = node.data as Record<string, unknown>
  if (node.type === 'http') return `${String(data.method ?? 'POST')} ${String(data.url ?? '')}`.trim()
  if (node.type === 'tool') return `tool: ${String(data.toolName ?? 'unknown')}`
  if (node.type === 'agent') return typeof data.input === 'string' && data.input.trim() ? `input: ${data.input.trim()}` : null
  if (node.type === 'wait') return `${String(data.amount ?? '')} ${String(data.unit ?? '')}`.trim()
  if (node.type === 'subflow') return `workflow: ${String(data.flowId ?? '')}`
  return null
}

/**
 * Render a standalone agent as Markdown — a system prompt someone can paste into
 * any LLM/agent builder. An agent is mostly instructions, so this target loses
 * almost nothing (unlike a flow, whose topology has to survive the trip).
 */
export function toAgentInstructions(doc: PortableAgentDoc): string {
  const { agent, requirements } = doc
  const lines: string[] = [`# ${agent.title}`, '']
  if (agent.goal) lines.push(`**Goal:** ${agent.goal}`, '')
  if (agent.model) lines.push(`**Model used on Sublime:** ${agent.model}`, '')
  lines.push('## Instructions (system prompt)', '', '```', agent.instructions, '```', '')
  if (agent.integrations.length) {
    lines.push('## Tools this agent expects', '')
    for (const integration of agent.integrations) lines.push(`- ${integration}`)
    lines.push('')
  }
  if (requirements.length) {
    lines.push('## Before it will run elsewhere', '')
    for (const requirement of requirements) lines.push(`- ${requirement}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render the portable document as Markdown. Steps are listed with their inputs
 * ("fed by"), which is what makes a DAG reconstructible on the other side.
 */
export function toInstructions(portable: PortableFlow): string {
  const { flow, agents, requirements } = portable
  const nodes = flow.graph.nodes ?? []
  const edges = flow.graph.edges ?? []
  const parentsOf = new Map<string, string[]>()
  for (const edge of edges) {
    const list = parentsOf.get(edge.target)
    if (list) list.push(edge.source)
    else parentsOf.set(edge.target, [edge.source])
  }
  const nameOf = new Map(nodes.map((node) => [node.id, labelOf(node)]))

  const lines: string[] = []
  lines.push(`# ${flow.name || 'Untitled workflow'}`, '')
  if (flow.description) lines.push(flow.description, '')
  lines.push(
    'Rebuild instructions exported from Sublime. Steps below list the steps that feed them,',
    'so branches and merges (several inputs into one step) can be reproduced exactly.',
    '',
  )

  const trigger = flow.trigger as { type?: string } | undefined
  lines.push(`**Trigger:** ${trigger?.type ?? 'manual'}`, '')

  lines.push('## Steps', '')
  for (const node of nodes) {
    if (node.type === 'trigger') continue
    const parents = parentsOf.get(node.id) ?? []
    const feeders = parents.length ? parents.map((id) => `"${nameOf.get(id) ?? id}"`).join(' + ') : 'the trigger'
    const detail = detailOf(node)
    lines.push(`### ${labelOf(node)}`)
    lines.push(`- **Does:** ${TYPE_PROSE[node.type] ?? node.type}`)
    if (detail) lines.push(`- **Config:** ${detail}`)
    lines.push(`- **Fed by:** ${feeders}`)
    lines.push('')
  }

  if (agents.length) {
    lines.push('## Agents used', '')
    for (const agent of agents) {
      lines.push(`### ${agent.title}`)
      if (agent.model) lines.push(`- **Model:** ${agent.model}`)
      if (agent.goal) lines.push(`- **Goal:** ${agent.goal}`)
      if (agent.integrations.length) lines.push(`- **Needs tools:** ${agent.integrations.join(', ')}`)
      lines.push('- **Instructions:**', '', '```', agent.instructions, '```', '')
    }
  }

  if (requirements.length) {
    lines.push('## Before this will run elsewhere', '')
    for (const requirement of requirements) lines.push(`- ${requirement}`)
    lines.push('')
  }

  lines.push(
    '## Note on data between steps',
    '',
    'Steps reference earlier output with `{{Step name.output.field}}` tokens, and an agent',
    'automatically receives the output of every step feeding it. On a platform without that',
    'behaviour, pass the upstream data into the agent/step input explicitly.',
    '',
  )
  return lines.join('\n')
}
