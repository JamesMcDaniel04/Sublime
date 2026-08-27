import { readAgentMetadata } from '@/lib/agents/metadata'
import { parseGrants } from '@/lib/agents/grants'
import { describeExternalBinding } from '@/lib/agents/external-agent'
import { normalizeRoleLabel } from '@/lib/agents/role-label'
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
  workerId: string | null
  visibility: string
  status: string
  schedule: unknown
  /** Optional so test fixtures and older callers need not carry it. */
  grants?: unknown
  runtime?: string
  /** The external binding when the caller loaded it; never carries the secret out. */
  externalBinding?: { endpointUrl: string; authType: string; authConfig: unknown; timeoutMinutes: number } | null
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
    avatarSeed: metadata.avatarSeed?.trim() || null,
    // Normalized here, not just at write time: metadata is an unvalidated JSON
    // grab-bag, so this is the last chokepoint before a label reaches a client.
    roleLabel: normalizeRoleLabel(metadata.roleLabel),
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
    // Null = this agent stands alone on the roster rather than working under
    // a shared avatar.
    workerId: agent.workerId ?? null,
    visibility: agent.visibility || 'shared',
    // null = legacy, unrestricted; the form shows that as write-everywhere.
    grants: parseGrants(agent.grants),
    runtime: agent.runtime ?? 'native',
    external: describeExternalBinding(agent.externalBinding),
    status: agent.status.toLowerCase(),
    schedule: agent.schedule,
    createdAt: agent.createdAt,
    lastExecutedAt: agent.lastExecutedAt,
    executionCount: agent.executionCount,
  }
}
