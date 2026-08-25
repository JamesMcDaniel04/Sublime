/**
 * Draft/published config for agents.
 *
 * Agents were LIVE ON SAVE: editing a production agent changed it mid-flight,
 * and there was no way to work on one without every scheduled and triggered
 * run picking the change up immediately. Flows have had `publishedGraph` for
 * a long time — this is the same idea for agents, and deliberately the same
 * shape so the two lifecycles read alike.
 *
 * **The compatibility rule is the design.** A NULL `publishedConfig` means the
 * agent has never been published, and runs read the live columns — which is
 * exactly today's behaviour. Nothing is backfilled, because silently giving
 * every agent in every workspace a draft state would change what runs for
 * people who never asked. An agent opts in the first time it is published.
 *
 * Pure: the writer lives in the route, this decides only *which config a run
 * executes* and *whether a draft differs*. That keeps the rule testable
 * without a database, which matters because getting it wrong means either
 * running the wrong config or freezing an agent nobody can edit.
 */

/**
 * The fields a publish freezes: everything that changes what a RUN does.
 *
 * Deliberately not `status`, `folder`, `workerId`, `visibility` or the
 * counters. Those describe where the agent sits and how it is shown, not what
 * it does — freezing them would mean republishing to move an agent between
 * folders, and pausing a published agent would silently unpause on republish.
 */
export const AGENT_CONFIG_FIELDS = ['description', 'objective', 'goal', 'schedule', 'metadata'] as const
export type AgentConfigField = (typeof AGENT_CONFIG_FIELDS)[number]

export type AgentConfig = Record<AgentConfigField, unknown>

/** The subset of an agent row these rules read. */
export interface AgentConfigSource {
  description?: unknown
  objective?: unknown
  goal?: unknown
  schedule?: unknown
  metadata?: unknown
  publishedConfig?: unknown
  [key: string]: unknown
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** Freeze the run-affecting fields of an agent row. */
export function snapshotAgentConfig(agent: AgentConfigSource): AgentConfig {
  return Object.fromEntries(AGENT_CONFIG_FIELDS.map((field) => [field, agent[field]])) as AgentConfig
}

/**
 * The config a run should execute.
 *
 * Falls back to the live column FIELD BY FIELD rather than wholesale: a
 * snapshot taken before a field existed would otherwise resolve that field to
 * undefined, and an undefined objective reaches the model as an empty prompt.
 * A malformed snapshot falls back entirely — a corrupt value must not take
 * the agent offline.
 */
export function agentConfigForRun(agent: AgentConfigSource): AgentConfig {
  const snapshot = asRecord(agent.publishedConfig)
  return Object.fromEntries(
    AGENT_CONFIG_FIELDS.map((field) => [field, snapshot && snapshot[field] !== undefined ? snapshot[field] : agent[field]]),
  ) as AgentConfig
}

/**
 * Does the draft differ from what is published?
 *
 * False for an unpublished agent — it has no draft state, so there is nothing
 * to report and the builder must not show "unpublished changes" on an agent
 * that has simply never been published.
 *
 * Compared by serialization: these are Json columns whose key order is not
 * stable across a round-trip, so a structural walk is what makes the answer
 * mean "different content" rather than "different object".
 */
export function agentDraftDiffers(agent: AgentConfigSource): boolean {
  const snapshot = asRecord(agent.publishedConfig)
  if (!snapshot) return false
  return AGENT_CONFIG_FIELDS.some((field) => !deepEqual(agent[field], snapshot[field]))
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every((key) => deepEqual(left[key], right[key]))
}
