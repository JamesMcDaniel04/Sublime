/**
 * Typed accessor for the `AgentTask.metadata` JSON grab-bag. Every field that
 * lives in metadata is declared here once, so reads stop scattering ad-hoc
 * `as any` casts across routes and workers (and stop silently drifting).
 */
export type AgentMetadata = {
  title?: string
  description?: string
  model?: string
  integrations?: string[]
  /** Durable product focus used to enforce plan-level specialist-area access. */
  specialistArea?: string
  /** Connections that must be live before this agent may run (set by templates). */
  requiredIntegrations?: string[]
  skills?: string[]
  icon?: string
  /** Maximum model/tool turns in one run (guardrail, configurable per agent). */
  maxTurns?: number
  headline?: string
  triggerSecretHash?: string
  /** Legacy plaintext trigger secret (superseded by triggerSecretHash). */
  triggerSecret?: string
  pendingQuestion?: unknown
  /** A write-plane tool call held for human approval (see features/agents/approval). */
  pendingApproval?: unknown
  /** When true, write-plane tool calls pause for human approval before executing. */
  requireApproval?: boolean
  allowSubagents?: boolean
  subagentIds?: string[]
  /** When true, a question closely matching a past answer is auto-answered from memory. */
  autoAnswerFromMemory?: boolean
  /** When true, every run starts with an explicit numbered plan before any tool call. */
  alwaysStrategize?: boolean
  /** AI-proposed goal surfaced from a run's reflection pass, pending user confirmation. */
  suggestedGoal?: string
  /** Optional structured response contract enforced by the runtime. */
  outputFields?: Array<{
    name: string
    type: 'string' | 'number' | 'boolean' | 'object' | 'array'
    description?: string
  }>
  responseFormat?: 'structured'
}

/** Parse an unknown JSON value into a typed AgentMetadata (never throws). */
export function readAgentMetadata(value: unknown): AgentMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AgentMetadata)
    : {}
}
