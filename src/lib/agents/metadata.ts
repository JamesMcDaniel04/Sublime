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
  skills?: string[]
  icon?: string
  maxTurns?: number
  headline?: string
  triggerSecretHash?: string
  /** Legacy plaintext trigger secret (superseded by triggerSecretHash). */
  triggerSecret?: string
  pendingQuestion?: unknown
}

/** Parse an unknown JSON value into a typed AgentMetadata (never throws). */
export function readAgentMetadata(value: unknown): AgentMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AgentMetadata)
    : {}
}
