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
  /** Seed for the generated portrait on the roster (lib/agents/avatar.ts).
   *  Absent means "derive from the agent id", which is why no agent needed a backfill. */
  avatarSeed?: string
  /** Generated one-or-two-word role shown under the name on the roster. People name
   *  agents anything, so the tile describes what it DOES (lib/agents/role-label.ts). */
  roleLabel?: string
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
  /** Lets this agent invoke saved flows as tools (the flow analog of subagents).
   *  Needed when an agent's instructions require deterministic multi-step tool
   *  work — HTTP/API calls, structured writes — that belongs in a flow graph. */
  allowFlows?: boolean
  /** Restrict which flows it may call. Empty/omitted while allowFlows is on =
   *  any of the org's active flows the owner can run. */
  flowIds?: string[]
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
  /** User-configured HTTP API endpoints exposed to the model as tools
   *  (validated shape: lib/agents/http-tools.ts agentHttpToolSchema). */
  httpTools?: unknown[]
}

/** Parse an unknown JSON value into a typed AgentMetadata (never throws). */
export function readAgentMetadata(value: unknown): AgentMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AgentMetadata)
    : {}
}
