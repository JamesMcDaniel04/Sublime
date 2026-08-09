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
  loadPostgresPlaneGroups,
  type ToolPlaneGroup,
} from '@/features/agents/tool-planes'
import type { GoalResource } from '@/lib/integrations/goals-port'
import { createHash } from 'crypto'
import { planesForConnectionIds } from '@/lib/flows/tool-connection-id'
import { loadVerifications } from '@/lib/connections/record-verification'
import { toVerification, type Verification } from '@/lib/connections/verification'

export { mcpConnectionScope } from '@/features/agents/tool-planes'

export type FlowToolSummary = { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown; schemaHash?: string; risk?: 'read' | 'write' | 'destructive' }

/** MCP tool annotations relevant to risk (see the MCP spec's ToolAnnotations). */
export type ToolRiskAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean }

const RISK_ORDER = { read: 0, write: 1, destructive: 2 } as const

/**
 * Risk classification for a tool. Structured annotations are preferred over
 * the name heuristic, but annotations are advisory (server-supplied and
 * unverifiable), so they may only RAISE the classification — on conflict the
 * riskier of (annotation, name-heuristic + group write flag) wins.
 */
export function riskForTool(
  name: string,
  groupWrite: boolean,
  annotations?: ToolRiskAnnotations,
): 'read' | 'write' | 'destructive' {
  const normalized = name.toLowerCase().replace(/[_-]/g, ' ')
  const heuristic: 'read' | 'write' | 'destructive' =
    /\b(delete|remove|destroy|revoke|archive|cancel|terminate|drop)\b/.test(normalized) ? 'destructive'
    : groupWrite || /\b(create|update|set|send|post|publish|upload|invite|add|write|execute|trigger|reply)\b/.test(normalized) ? 'write'
    : 'read'
  const hinted: 'read' | 'write' | 'destructive' | undefined =
    annotations?.destructiveHint === true ? 'destructive'
    : annotations?.readOnlyHint === true ? 'read'
    : annotations?.readOnlyHint === false ? 'write'
    : undefined
  if (!hinted) return heuristic
  return RISK_ORDER[hinted] > RISK_ORDER[heuristic] ? hinted : heuristic
}
export type FlowToolCatalogConnection = { id: string; name: string; provider?: string; tools: FlowToolSummary[]; toolsError?: string; verification?: Verification }

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
  const wantPlane = (plane: 'mcp' | 'native' | 'nango' | 'postgres') => !wanted || wanted.planes.has(plane)

  const [mcp, native, nango, postgres] = await Promise.all([
    wantPlane('mcp') && (!wanted || wanted.mcpIds.length)
      ? loadMcpConnectionPlaneGroups(organizationId, options.userId, {
          connectionIds: wanted?.mcpIds,
          take: options.takeConnections ?? 25,
        }).catch(() => [] as ToolPlaneGroup[])
      : [],
    wantPlane('native')
      ? loadNativePlaneGroups(organizationId, { resource: options.resource, userId: options.userId }).catch(
          () => [] as ToolPlaneGroup[],
        )
      : [],
    wantPlane('nango') ? loadNangoPlaneGroups(organizationId, options.userId).catch(() => [] as ToolPlaneGroup[]) : [],
    wantPlane('postgres') ? loadPostgresPlaneGroups(organizationId).catch(() => [] as ToolPlaneGroup[]) : [],
  ])

  // MCP rows stay first so existing pickers/graphs see a stable ordering, then
  // the remaining planes.
  const groups = [...mcp, ...native, ...nango, ...postgres]
  const wantedIds = wanted ? new Set(options.connectionIds) : null
  // Whether each connection has actually been proven to work. A missing row
  // reads as `unverified` — never as healthy, which is the point.
  const verifications = await loadVerifications(organizationId, groups.map((group) => group.id))
  return groups
    .filter((group) => !wantedIds || wantedIds.has(group.id))
    .map((group) => ({
      id: group.id,
      name: group.name,
      // The stable provider id (e.g. 'slack') — template binding matches on
      // this first, because display names may embed per-org detail.
      ...(group.provider ? { provider: group.provider } : {}),
      ...(group.toolsError ? { toolsError: group.toolsError } : {}),
      verification: toVerification(verifications.get(group.id)),
      tools: group.tools.slice(0, options.takeTools ?? group.tools.length).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? null,
        outputSchema: tool.outputSchema ?? null,
        schemaHash: createHash('sha256').update(JSON.stringify({ input: tool.inputSchema ?? null, output: tool.outputSchema ?? null })).digest('hex'),
        risk: riskForTool(tool.name, group.isWrite, tool.annotations),
      })),
    }))
}
