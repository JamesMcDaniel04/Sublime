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
  /** Connections that must be live before this agent may run (set by templates). */
  requiredIntegrations?: string[]
  skills?: string[]
  icon?: string
  maxTurns?: number
  headline?: string
  triggerSecretHash?: string
  /** Legacy plaintext trigger secret (superseded by triggerSecretHash). */
  triggerSecret?: string
  pendingQuestion?: unknown
  allowSubagents?: boolean
  subagentIds?: string[]
  /** When true, a question closely matching a past answer is auto-answered from memory. */
  autoAnswerFromMemory?: boolean
  /** When true, every run starts with an explicit numbered plan before any tool call. */
  alwaysStrategize?: boolean
  /** AI-proposed goal surfaced from a run's reflection pass, pending user confirmation. */
  suggestedGoal?: string
}

/** Parse an unknown JSON value into a typed AgentMetadata (never throws). */
export function readAgentMetadata(value: unknown): AgentMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AgentMetadata)
    : {}
}
