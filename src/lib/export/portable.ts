/**
 * Portable export — the universal, always-works target.
 *
 * A flow only makes sense elsewhere if it travels with the things it references:
 * the agents it runs are inlined (a bare `agentId` is meaningless on another
 * platform), and every step keeps its wiring so the DAG can be rebuilt.
 *
 * SAFETY: sanitization is the DEFAULT — an export leaves this platform, so it
 * carries no credentials unless the flow's OWNER opts in per download:
 *   - `trigger.webhookSecretHash`/`webhookSecretEnc` are always dropped
 *   - Authorization/Proxy-Authorization headers and Cookie are redacted
 *   - a connection reference exports as a NAME + a "reconnect this" requirement,
 *     never a token — connections are per-user OAuth grants and cannot travel
 * With `includeCredentials` (owner-only; enforced by the export route), the
 * plaintext trigger secrets live EXCLUSIVELY in the top-level `credentials`
 * block — never inside flow.trigger — and user-typed HTTP credentials stay in
 * their steps. The document says so loudly in `requirements`.
 *
 * The result is deliberately plain JSON with a version, so an importer (ours or
 * an LLM) can read it without knowing our internals.
 */
import { redactAuthHeaders, redactHttpAuthOption } from '@/features/flows/http'
import { REDACTED, redactDeep, redactUrl } from './redact'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

export const PORTABLE_FORMAT = 'sublime.flow'
export const PORTABLE_AGENT_FORMAT = 'sublime.agent'
export const PORTABLE_VERSION = 1

export type PortableAgent = {
  /** The id this flow's agent steps reference. */
  ref: string
  title: string
  instructions: string
  goal?: string | null
  model?: string
  /** Connector keys the agent expects — must be reconnected on the target. */
  integrations: string[]
}

export type PortableCredentials = {
  /** Plaintext webhook trigger secret for this flow, if it has one. */
  triggerSecret?: string
  /** Plaintext trigger secrets for inlined agents, keyed by PortableAgent.ref. */
  agentTriggerSecrets?: Record<string, string>
}

export type PortableExportOptions = { includeCredentials?: boolean } & PortableCredentials

export type PortableFlow = {
  format: typeof PORTABLE_FORMAT
  version: typeof PORTABLE_VERSION
  exportedAt: string
  /** Present (true) only when the export was made with credentials embedded. */
  containsCredentials?: true
  /** Live secrets — present only when containsCredentials. NEVER placed inside flow.trigger. */
  credentials?: PortableCredentials
  flow: {
    name: string
    description: string
    trigger: unknown
    /** nodes + edges + layout: the DAG, exactly as built. */
    graph: FlowGraph
  }
  /** Every agent referenced by an agent step, inlined so the export stands alone. */
  agents: PortableAgent[]
  /**
   * What a human/importer must supply on the other side. Credentials never
   * travel, so these are stated explicitly rather than failing silently later.
   */
  requirements: string[]
}

/** A standalone agent export (no flow) — the agent is the unit people share. */
export type PortableAgentDoc = {
  format: typeof PORTABLE_AGENT_FORMAT
  version: typeof PORTABLE_VERSION
  exportedAt: string
  agent: PortableAgent
  requirements: string[]
}

/**
 * Export one agent on its own. An agent is mostly instructions + a model, which
 * port cleanly anywhere; what does NOT port are its tool connections, so those
 * are named as requirements rather than exported as dangling ids.
 */
export function toPortableAgent(
  agent: { id: string; title: string; instructions: string; goal?: string | null; model?: string; integrations?: string[] },
  exportedAt: string,
): PortableAgentDoc {
  const integrations = agent.integrations ?? []
  return {
    format: PORTABLE_AGENT_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt,
    agent: {
      ref: agent.id,
      title: agent.title,
      instructions: agent.instructions,
      goal: agent.goal ?? null,
      model: agent.model,
      integrations,
    },
    requirements: integrations.length
      ? [`Connect the tools this agent expects: ${integrations.join(', ')}. Credentials are never exported.`]
      : [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Strip the webhook secret hash + ciphertext — credentials, useless off-platform. */
function sanitizeTrigger(trigger: unknown): unknown {
  if (!isRecord(trigger)) return trigger ?? { type: 'manual' }
  const rest = { ...trigger }
  delete rest.webhookSecretHash
  // Ciphertext is a credential too; the PLAINTEXT travels (opt-in) in the
  // top-level credentials block, never here — in EVERY mode.
  delete rest.webhookSecretEnc
  return rest
}

/**
 * Redact anything credential-shaped a user may have typed into a step.
 *
 * Auth headers are NOT the only hiding place — a token is just as often in the
 * URL (`?api_key=…`, `user:pass@host`), the query field, or the body of APIs
 * that authenticate that way. Each of those is stripped by key name, so the step
 * stays rebuildable while the credential does not travel.
 */
function sanitizeNode(node: FlowNode, includeCredentials: boolean): FlowNode {
  // Owner opted in: user-typed secrets travel verbatim. The redaction helpers
  // below stay UNCONDITIONAL — redactHttpAuthOption is shared with the
  // persisted-run-row sanitizer, so the opt-in must live here, one level up.
  if (includeCredentials) return node
  if (node.type === 'http') {
    const data = { ...node.data } as Record<string, unknown>
    // `redactAuthHeaders` is the same helper that keeps tokens out of persisted
    // run rows; redactDeep additionally catches api-key-style custom headers.
    if (data.headers !== undefined) data.headers = redactDeep(redactAuthHeaders(data.headers))
    // The generic auth option holds the credential inline (password/token/value)
    // — shares its field list with the run-row redactor so the two can't drift.
    if (data.auth !== undefined) data.auth = redactHttpAuthOption(data.auth)
    if (typeof data.url === 'string') data.url = redactUrl(data.url)
    if (data.query !== undefined) data.query = redactDeep(data.query)
    if (data.body !== undefined) data.body = redactDeep(data.body)
    // The Cookie convenience field is a credential by definition.
    if (typeof data.cookie === 'string' && data.cookie.trim()) data.cookie = REDACTED
    return { ...node, data } as FlowNode
  }
  if (node.type === 'tool') {
    // Tool args are user-authored JSON and can carry a key for the target API.
    const data = { ...node.data } as Record<string, unknown>
    if (data.args !== undefined) data.args = redactDeep(data.args)
    return { ...node, data } as FlowNode
  }
  return node
}

/** Human-readable label for a step, matching what the builder shows. */
function labelOf(node: FlowNode): string {
  const data = node.data as { label?: string }
  return data.label?.trim() || node.type
}

/**
 * Build the portable document. `agents` should be every agent the flow's agent
 * steps reference; missing ones are reported as a requirement rather than
 * silently producing an export that can't run.
 */
export function toPortableFlow(
  flow: { name: string; description?: string; trigger?: unknown; graph: FlowGraph },
  agents: { id: string; title: string; instructions: string; goal?: string | null; model?: string; integrations?: string[] }[],
  exportedAt: string,
  options: PortableExportOptions = {},
): PortableFlow {
  const includeCredentials = options.includeCredentials === true
  const nodes = (flow.graph.nodes ?? []).map((node) => sanitizeNode(node, includeCredentials))
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const requirements: string[] = []
  if (includeCredentials) {
    requirements.push(
      '⚠ This file contains live credentials (trigger secrets and any keys typed into HTTP steps). Anyone holding it can trigger your flow — share it like a password.',
    )
  }

  // Agents referenced by the graph, inlined.
  const referenced = new Set(
    nodes.filter((node) => node.type === 'agent').map((node) => (node.data as { agentId?: string }).agentId).filter((id): id is string => Boolean(id)),
  )
  const inlined: PortableAgent[] = []
  for (const ref of referenced) {
    const agent = byId.get(ref)
    if (!agent) {
      requirements.push(`An agent step references an agent (${ref}) you can no longer see — re-create it on the target.`)
      continue
    }
    inlined.push({
      ref,
      title: agent.title,
      instructions: agent.instructions,
      goal: agent.goal ?? null,
      model: agent.model,
      integrations: agent.integrations ?? [],
    })
  }

  // Connections are per-user OAuth grants; they cannot travel. Name what must be
  // reconnected rather than exporting a dangling id.
  const toolSteps = nodes.filter((node) => node.type === 'tool')
  if (toolSteps.length) {
    requirements.push(
      `Reconnect the integrations used by: ${[...new Set(toolSteps.map(labelOf))].join(', ')}. ${
        includeCredentials
          ? 'OAuth connections cannot travel — reconnect them on the target.'
          : 'Credentials are never exported.'
      }`,
    )
  }
  if (!includeCredentials && nodes.some((node) => node.type === 'http')) {
    requirements.push(
      'Re-enter any API keys/tokens for HTTP steps — credentials are redacted on export wherever they appear (Authorization headers, cookies, URL user:pass, and api_key/token/secret values in the URL, query or body).',
    )
  }
  const agentIntegrations = [...new Set(inlined.flatMap((agent) => agent.integrations))]
  if (agentIntegrations.length) {
    requirements.push(`Connect the tools the inlined agents expect: ${agentIntegrations.join(', ')}.`)
  }

  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt,
    ...(includeCredentials
      ? {
          containsCredentials: true as const,
          credentials: {
            ...(options.triggerSecret ? { triggerSecret: options.triggerSecret } : {}),
            ...(options.agentTriggerSecrets && Object.keys(options.agentTriggerSecrets).length
              ? { agentTriggerSecrets: options.agentTriggerSecrets }
              : {}),
          },
        }
      : {}),
    flow: {
      name: flow.name,
      description: flow.description ?? '',
      trigger: sanitizeTrigger(flow.trigger),
      graph: { ...flow.graph, nodes },
    },
    agents: inlined,
    requirements,
  }
}
