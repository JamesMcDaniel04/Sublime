/**
 * Flow tool catalog — the connections a flow's tool step can call.
 *
 * Flows draw from the SAME five tool planes as agents (see
 * @/features/agents/tool-planes): People.ai (Sales AI), Klavis-managed MCP
 * servers, per-org MCP connections, native built-ins (Granola/Slack/HTTP/
 * Email), and Nango delivery (outbound writes).
 *
 * Connection id scheme (stored in a tool node's `connectionId`; see
 * @/lib/flows/tool-connection-id for the parser the executor routes on):
 *   - MCP connection rows keep their RAW database id — backward compatible
 *     with graphs stored before multi-plane support.
 *   - klavis:<mcpAgentId>  — a Klavis-provisioned MCP server row
 *   - native:<providerId>  — a built-in integration (granola|slack|http|email)
 *   - nango:<capability>   — a Nango delivery capability (slack|gmail|salesforce)
 *
 * Return shape is unchanged ({ id, name, tools[] }[]); new planes appear as
 * additional entries. A plane that errors degrades to no/empty entries — the
 * catalog never throws for one bad plane. No secrets are ever included: only
 * ids, names, and tool schemas.
 */
import {
  loadKlavisPlaneGroups,
  loadMcpConnectionPlaneGroups,
  loadNangoPlaneGroups,
  loadNativePlaneGroups,
  type ToolPlaneGroup,
} from '@/features/agents/tool-planes'
import { createHash } from 'crypto'
import { planesForConnectionIds } from '@/lib/flows/tool-connection-id'

export { mcpConnectionScope } from '@/features/agents/tool-planes'

export type FlowToolSummary = { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown; schemaHash?: string; risk?: 'read' | 'write' | 'destructive' }
export type FlowToolCatalogConnection = { id: string; name: string; tools: FlowToolSummary[]; toolsError?: string }

export async function loadFlowToolCatalog(
  organizationId: string,
  options: { userId?: string; takeConnections?: number; takeTools?: number; connectionIds?: string[] } = {},
): Promise<FlowToolCatalogConnection[]> {
  // When the caller only needs specific connections (run/publish validation),
  // load just the planes those ids reference.
  const wanted = options.connectionIds?.length ? planesForConnectionIds(options.connectionIds) : null
  const wantPlane = (plane: 'klavis' | 'mcp' | 'native' | 'nango') => !wanted || wanted.planes.has(plane)

  const [klavis, mcp, native, nango] = await Promise.all([
    wantPlane('klavis') ? loadKlavisPlaneGroups(organizationId).catch(() => [] as ToolPlaneGroup[]) : [],
    wantPlane('mcp') && (!wanted || wanted.mcpIds.length)
      ? loadMcpConnectionPlaneGroups(organizationId, options.userId, {
          connectionIds: wanted?.mcpIds,
          take: options.takeConnections ?? 25,
          includeStrata: true,
        }).catch(() => [] as ToolPlaneGroup[])
      : [],
    wantPlane('native') ? loadNativePlaneGroups(organizationId).catch(() => [] as ToolPlaneGroup[]) : [],
    wantPlane('nango') ? loadNangoPlaneGroups(organizationId, options.userId).catch(() => [] as ToolPlaneGroup[]) : [],
  ])

  // MCP rows stay first so existing pickers/graphs see a stable ordering, then
  // the remaining planes.
  const groups = [...mcp, ...klavis, ...native, ...nango]
  const wantedIds = wanted ? new Set(options.connectionIds) : null
  const riskFor = (name: string, groupWrite: boolean): 'read' | 'write' | 'destructive' => {
    const normalized = name.toLowerCase()
    if (/\b(delete|remove|destroy|revoke|archive|cancel|terminate|drop)\b/.test(normalized.replace(/[_-]/g, ' '))) return 'destructive'
    if (groupWrite || /\b(create|update|set|send|post|publish|upload|invite|add|write|execute|trigger|reply)\b/.test(normalized.replace(/[_-]/g, ' '))) return 'write'
    return 'read'
  }
  return groups
    .filter((group) => !wantedIds || wantedIds.has(group.id))
    .map((group) => ({
      id: group.id,
      name: group.name,
      ...(group.toolsError ? { toolsError: group.toolsError } : {}),
      tools: group.tools.slice(0, options.takeTools ?? group.tools.length).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? null,
        outputSchema: tool.outputSchema ?? null,
        schemaHash: createHash('sha256').update(JSON.stringify({ input: tool.inputSchema ?? null, output: tool.outputSchema ?? null })).digest('hex'),
        risk: riskFor(tool.name, group.isWrite),
      })),
    }))
}
