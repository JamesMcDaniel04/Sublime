import { readAgentMetadata } from '@/lib/agents/metadata'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'

/**
 * The wire shape for an agent, shared by /api/agents and /api/snapshot so the
 * two lists are always interchangeable on the client.
 */
export function serializeAgent(agent: {
  id: string
  description: string
  objective: string
  metadata: unknown
  folder: string | null
  visibility: string
  status: string
  priority: string
  schedule: unknown
  createdAt: Date
  lastExecutedAt: Date | null
  executionCount: number
}) {
  const metadata = readAgentMetadata(agent.metadata)
  return {
    id: agent.id,
    title: metadata.title || agent.description.split('\n')[0] || 'Untitled agent',
    description: metadata.description || agent.description,
    instructions: agent.objective,
    model: metadata.model || DEFAULT_AGENT_MODEL,
    integrations: metadata.integrations || [],
    skills: metadata.skills || [],
    icon: metadata.icon || '',
    allowSubagents: (metadata as { allowSubagents?: boolean }).allowSubagents === true,
    folder: agent.folder || null,
    visibility: agent.visibility || 'shared',
    status: agent.status.toLowerCase(),
    priority: agent.priority.toLowerCase(),
    schedule: agent.schedule,
    createdAt: agent.createdAt,
    lastExecutedAt: agent.lastExecutedAt,
    executionCount: agent.executionCount,
  }
}
