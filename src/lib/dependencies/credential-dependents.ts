/**
 * "What breaks if I revoke this?"
 *
 * The credential vault knew what existed; nothing knew what DEPENDED on it. A
 * connection could be deleted and the damage found later by a flow failing at
 * 3am — the failure n8n's credential-dependency table exists to prevent.
 *
 * Half of this already worked. `collectFlowCredentialRefs` walks flow graphs
 * for the credentials tab, and its rules are already the ones EXECUTION uses
 * (authMode handling, `flow:`/`template:` refs excluded). This reuses it
 * rather than writing a second walker that would drift from the executor —
 * the whole value of the answer is that it matches what actually runs.
 *
 * What is added: the reverse direction (given a ref, who uses it) and AGENTS,
 * whose connections live in `AgentConnector` rows that no dependency walk
 * looked at.
 *
 * Pure over already-loaded rows, so one answer backs a settings page, a delete
 * confirmation and a pre-revoke check without three implementations.
 */
import { collectFlowCredentialRefs, type FlowRef } from '@/lib/flows/credential-usage'

export interface DependencyInput {
  /** Flows with both graphs — an ACTIVE flow runs publishedGraph. */
  flows: Array<{ id: string; name: string; graph: unknown; publishedGraph: unknown }>
  /** Agent connector bindings, joined to their agent's name. */
  agentConnectors: Array<{
    agentTaskId: string
    agentName: string
    connectorKey: string
    kind: string
    mcpConnectionId: string | null
  }>
}

export interface AgentRef {
  id: string
  name: string
}

export interface DependentsResult {
  flows: FlowRef[]
  agents: AgentRef[]
  total: number
  /** Nothing depends on this, so revoking it breaks nothing we can see. */
  safeToRevoke: boolean
}

/**
 * Everything that depends on `ref` — a vault credential id, a plane-scoped
 * connection id (`nango:slack`), or an MCP connection row id.
 *
 * One `ref` parameter rather than a typed union on purpose: the caller is a
 * delete button that has an id and wants to know whether pressing it is safe,
 * and making it classify the id first would just move the guesswork.
 */
export function credentialDependents(input: DependencyInput, ref: string): DependentsResult {
  // Both graphs: a credential referenced only by the published graph is still
  // load-bearing, because that is what an active flow executes.
  const refs = collectFlowCredentialRefs(
    input.flows.map((flow) => ({ id: flow.id, name: flow.name, graphs: [flow.graph, flow.publishedGraph] })),
  )

  // A ref may be either kind; check both maps rather than asking the caller.
  const flowsUsing = [...(refs.credentials.get(ref) ?? []), ...(refs.connections.get(ref) ?? [])]

  // Deduplicate: one flow using the same credential in several steps is one
  // dependent, not three — a confirmation dialog saying "3 flows" when it is
  // one flow is worse than saying nothing.
  const seenFlows = new Set<string>()
  const flows = flowsUsing.filter((flow) => (seenFlows.has(flow.id) ? false : (seenFlows.add(flow.id), true)))

  const seenAgents = new Set<string>()
  const agents: AgentRef[] = []
  for (const connector of input.agentConnectors) {
    // An MCP binding is addressable by its row id as well as its key: the
    // delete button on an MCP connection has the row id, not the key.
    const matches = connector.connectorKey === ref || connector.mcpConnectionId === ref
    if (!matches || seenAgents.has(connector.agentTaskId)) continue
    seenAgents.add(connector.agentTaskId)
    agents.push({ id: connector.agentTaskId, name: connector.agentName })
  }

  const total = flows.length + agents.length
  return { flows, agents, total, safeToRevoke: total === 0 }
}
