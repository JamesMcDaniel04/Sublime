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
  goal: string | null
  metadata: unknown
  folder: string | null
  visibility: string
  status: string
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
    goal: agent.goal || null,
    model: metadata.model || DEFAULT_AGENT_MODEL,
    integrations: metadata.integrations || [],
    specialistArea: metadata.specialistArea || 'general',
    requiredIntegrations: metadata.requiredIntegrations || [],
    skills: metadata.skills || [],
    icon: metadata.icon || '',
    allowSubagents: (metadata as { allowSubagents?: boolean }).allowSubagents === true,
    subagentIds: ((metadata as { subagentIds?: string[] }).subagentIds ?? []).filter((id) => typeof id === 'string'),
    allowFlows: metadata.allowFlows === true,
    flowIds: (metadata.flowIds ?? []).filter((id) => typeof id === 'string'),
    // Undefined is the legacy value; remembered blocking answers are now the
    // safe default unless an agent explicitly opts out.
    autoAnswerFromMemory: metadata.autoAnswerFromMemory !== false,
    requireApproval: metadata.requireApproval === true,
    alwaysStrategize: metadata.alwaysStrategize === true,
    maxTurns: typeof metadata.maxTurns === 'number' ? metadata.maxTurns : 16,
    outputFields: Array.isArray(metadata.outputFields) ? metadata.outputFields : [],
    httpTools: Array.isArray(metadata.httpTools) ? metadata.httpTools : [],
    suggestedGoal: metadata.suggestedGoal || null,
    folder: agent.folder || null,
    visibility: agent.visibility || 'shared',
    status: agent.status.toLowerCase(),
    schedule: agent.schedule,
    createdAt: agent.createdAt,
    lastExecutedAt: agent.lastExecutedAt,
    executionCount: agent.executionCount,
  }
}
