/**
 * Flow tool-step connection id scheme.
 *
 * A tool node stores a `connectionId` that identifies which tool plane (and
 * which concrete connection within it) executes the step:
 *
 *   - MCP connection rows keep their RAW database id (no prefix) so graphs
 *     stored before multi-plane support keep working unchanged.
 *   - Every other plane uses a `<plane>:<ref>` synthetic id:
 *       klavis:<mcpAgentId>   — a Klavis-provisioned MCP server row
 *       native:<providerId>   — a built-in integration (granola|slack|http|email)
 *       nango:<capability>    — a Nango delivery capability (slack|gmail|salesforce)
 *
 * Parsing is pure so execution routing and the catalog agree on one scheme.
 * An id with an unrecognized prefix is treated as a raw MCP row id (colons are
 * technically legal there), which preserves backward compatibility.
 */

export const FLOW_TOOL_PLANES = ['klavis', 'mcp', 'native', 'nango'] as const
export type FlowToolPlane = (typeof FLOW_TOOL_PLANES)[number]

/** Planes that use a `<plane>:<ref>` prefix (mcp rows stay raw). */
const PREFIXED_PLANES = new Set<FlowToolPlane>(['klavis', 'native', 'nango'])

export type ParsedFlowToolConnectionId = { plane: FlowToolPlane; ref: string }

/** Build the catalog/graph id for a plane connection. MCP rows stay raw. */
export function formatFlowToolConnectionId(plane: FlowToolPlane, ref: string): string {
  return plane === 'mcp' ? ref : `${plane}:${ref}`
}

/** Parse a stored connection id into its plane + plane-local ref. */
export function parseFlowToolConnectionId(id: string): ParsedFlowToolConnectionId {
  const sep = id.indexOf(':')
  if (sep > 0) {
    const head = id.slice(0, sep) as FlowToolPlane
    if (PREFIXED_PLANES.has(head)) return { plane: head, ref: id.slice(sep + 1) }
  }
  return { plane: 'mcp', ref: id }
}

/**
 * Which planes a set of stored connection ids needs, plus the raw MCP row ids —
 * used to load only the relevant slices of the catalog for validation.
 */
export function planesForConnectionIds(ids: string[]): { planes: Set<FlowToolPlane>; mcpIds: string[] } {
  const planes = new Set<FlowToolPlane>()
  const mcpIds: string[] = []
  for (const id of ids) {
    const parsed = parseFlowToolConnectionId(id)
    planes.add(parsed.plane)
    if (parsed.plane === 'mcp') mcpIds.push(parsed.ref)
  }
  return { planes, mcpIds }
}
