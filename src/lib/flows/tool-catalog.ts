/**
 * Flow tool catalog — the connections a flow's tool step can call.
 *
 * Flows draw from the SAME tool planes as agents (see
 * @/features/agents/tool-planes): per-org MCP connections, native built-ins
 * (Granola/Slack/HTTP/Email), and Nango delivery (outbound writes).
 *
 * Connection id scheme (stored in a tool node's `connectionId`; see
 * @/lib/flows/tool-connection-id for the parser the executor routes on):
 *   - MCP connection rows keep their RAW database id — backward compatible
 *     with graphs stored before multi-plane support.
 *   - native:<providerId>  — a built-in integration (granola|slack|http|email)
 *   - nango:<capability>   — a Nango delivery capability (slack|gmail|salesforce)
 *
 * Return shape is unchanged ({ id, name, tools[] }[]); new planes appear as
 * additional entries. A plane that errors degrades to no/empty entries — the
 * catalog never throws for one bad plane. No secrets are ever included: only
 * ids, names, and tool schemas.
 */
import {
  loadMcpConnectionPlaneGroups,
  loadNangoPlaneGroups,
  loadNativePlaneGroups,
  type ToolPlaneGroup,
} from '@/features/agents/tool-planes'
import type { GoalResource } from '@/lib/integrations/goals-port'
import { createHash } from 'crypto'
import { planesForConnectionIds } from '@/lib/flows/tool-connection-id'
import { loadVerifications } from '@/lib/connections/record-verification'
import { toVerification, type Verification } from '@/lib/connections/verification'

export { mcpConnectionScope } from '@/features/agents/tool-planes'

export type FlowToolSummary = { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown; schemaHash?: string; risk?: 'read' | 'write' | 'destructive' }
export type FlowToolCatalogConnection = { id: string; name: string; tools: FlowToolSummary[]; toolsError?: string; verification?: Verification }

export async function loadFlowToolCatalog(
  organizationId: string,
  options: {
    userId?: string
    takeConnections?: number
    takeTools?: number
    connectionIds?: string[]
    /** The flow being run/validated. Omitted by the builder's tool picker, so
     *  the goals plane stays absent there until a flow is linked to a goal. */
    resource?: GoalResource
  } = {},
): Promise<FlowToolCatalogConnection[]> {
  // When the caller only needs specific connections (run/publish validation),
  // load just the planes those ids reference.
  const wanted = options.connectionIds?.length ? planesForConnectionIds(options.connectionIds) : null
  const wantPlane = (plane: 'mcp' | 'native' | 'nango') => !wanted || wanted.planes.has(plane)

  const [mcp, native, nango] = await Promise.all([
    wantPlane('mcp') && (!wanted || wanted.mcpIds.length)
      ? loadMcpConnectionPlaneGroups(organizationId, options.userId, {
          connectionIds: wanted?.mcpIds,
          take: options.takeConnections ?? 25,
        }).catch(() => [] as ToolPlaneGroup[])
      : [],
    wantPlane('native')
      ? loadNativePlaneGroups(organizationId, { resource: options.resource }).catch(
          () => [] as ToolPlaneGroup[],
        )
      : [],
    wantPlane('nango') ? loadNangoPlaneGroups(organizationId, options.userId).catch(() => [] as ToolPlaneGroup[]) : [],
  ])

  // MCP rows stay first so existing pickers/graphs see a stable ordering, then
  // the remaining planes.
  const groups = [...mcp, ...native, ...nango]
  const wantedIds = wanted ? new Set(options.connectionIds) : null
  // Whether each connection has actually been proven to work. A missing row
  // reads as `unverified` — never as healthy, which is the point.
  const verifications = await loadVerifications(organizationId, groups.map((group) => group.id))
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
      verification: toVerification(verifications.get(group.id)),
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
