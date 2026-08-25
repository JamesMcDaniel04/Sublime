import type { FlowGraph } from '@/lib/flows/graph'
import { inputParamsFromGraph, flowInputJsonSchema, flowToolSlug } from '@/lib/flows/flow-tool'
import { flowCallableAsTool } from '@/lib/flows/settings'
import type { McpTool } from './server-protocol'

/**
 * Which flows an external MCP client can see and run.
 *
 * **The decision this file exists to get right.** `flowCallableAsTool`
 * defaults to TRUE when unset, which is correct for INTERNAL flow-to-flow
 * calls — a workspace's own flows calling each other, inside one trust
 * boundary. Reusing that rule here would have silently published every flow in
 * every workspace to anyone holding an API key, the moment this shipped.
 *
 * So MCP exposure is its own opt-in and it fails closed: a flow is invisible
 * to an external client until someone says otherwise, and the internal setting
 * can only ever narrow that further, never widen it.
 */

export interface ExposableFlow {
  id: string
  name: string
  description?: string | null
  metadata?: unknown
  /** What actually runs. A flow with none has nothing reviewed to expose. */
  publishedGraph?: unknown
}

function metadataOf(flow: ExposableFlow): Record<string, unknown> {
  return flow.metadata && typeof flow.metadata === 'object' && !Array.isArray(flow.metadata)
    ? (flow.metadata as Record<string, unknown>)
    : {}
}

/**
 * Whether this flow may be reached over MCP.
 *
 * Three conditions, all required:
 *
 *   1. an explicit opt-in — and only a literal `true`, so a truthy string from
 *      an import or a hand-edited metadata blob cannot read as consent;
 *   2. a published graph, because exposing the draft would let an external
 *      client run an unfinished edit nobody reviewed;
 *   3. the internal caller policy still permits it, so a flow that refuses
 *      callers is not quietly overridden by the MCP opt-in.
 */
export function flowExposedToMcp(flow: ExposableFlow): boolean {
  if (metadataOf(flow).mcpExposed !== true) return false
  if (!flow.publishedGraph) return false
  return flowCallableAsTool(flow.metadata)
}

/**
 * The exposed flows as MCP tools.
 *
 * Names are slugged from the flow name and de-duplicated: two flows sharing a
 * name would otherwise produce two tools a client cannot tell apart, and the
 * second would shadow the first in every lookup.
 *
 * The schema comes from the PUBLISHED graph's declared inputs, since that is
 * the version a call will actually run.
 */
export function mcpToolsFor(flows: ExposableFlow[]): McpTool[] {
  const used = new Set<string>()
  const tools: McpTool[] = []

  for (const flow of flows) {
    if (!flowExposedToMcp(flow)) continue

    let name = flowToolSlug(flow.name)
    if (used.has(name)) {
      // Suffix rather than drop: a shadowed tool is worse than an ugly name,
      // because the flow silently becomes unreachable.
      let suffix = 2
      while (used.has(`${name}_${suffix}`)) suffix++
      name = `${name}_${suffix}`
    }
    used.add(name)

    tools.push({
      name,
      // A model choosing between tools needs something to go on; an empty
      // description makes a tool unusable in practice.
      description: flow.description?.trim() || `Run the "${flow.name}" flow.`,
      inputSchema: flowInputJsonSchema(inputParamsFromGraph(flow.publishedGraph as FlowGraph)),
      flowId: flow.id,
    })
  }

  return tools
}
