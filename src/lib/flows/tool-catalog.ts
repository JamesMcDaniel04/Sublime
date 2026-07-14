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
import { formatFlowToolConnectionId, planesForConnectionIds } from '@/lib/flows/tool-connection-id'
import { fromKlavisAgentType } from '@/lib/connectors/registry'
import { PROVIDERS, PROVIDER_CAPABILITIES } from '@/lib/mcp/provider-capabilities'
import { KlavisClient, type KlavisCatalogServer } from '@/lib/mcp/klavis-client'
import { cacheGet, cacheSet } from '@/lib/cache'

export { mcpConnectionScope } from '@/features/agents/tool-planes'

export type FlowToolSummary = { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown; schemaHash?: string; risk?: 'read' | 'write' | 'destructive' }
export type FlowToolCatalogConnection = {
  id: string
  name: string
  tools: FlowToolSummary[]
  toolsError?: string
  /** Absent = connected (backward compatible). `false` = browsable-but-not-connected. */
  connected?: boolean
  /** Present on not-yet-connected connectors: how to connect before inserting. */
  connect?: { plane: 'klavis'; provider: string }
}

const riskFor = (name: string, groupWrite: boolean): 'read' | 'write' | 'destructive' => {
  const normalized = name.toLowerCase()
  if (/\b(delete|remove|destroy|revoke|archive|cancel|terminate|drop)\b/.test(normalized.replace(/[_-]/g, ' '))) return 'destructive'
  if (groupWrite || /\b(create|update|set|send|post|publish|upload|invite|add|write|execute|trigger|reply)\b/.test(normalized.replace(/[_-]/g, ' '))) return 'write'
  return 'read'
}

const NULL_SCHEMA_HASH = createHash('sha256').update(JSON.stringify({ input: null, output: null })).digest('hex')

// The connectable-provider catalogue is a property of the KLAVIS_API_KEY account
// (identical for every org in the deployment), so a live `/mcp-server/servers`
// round-trip on every picker open is wasteful. Cache it briefly.
const KLAVIS_CATALOG_CACHE_KEY = 'klavis:catalog'
const KLAVIS_CATALOG_TTL_MS = 10 * 60 * 1000

async function fetchKlavisCatalog(): Promise<KlavisCatalogServer[]> {
  if (!process.env.KLAVIS_API_KEY) return []
  const hit = await cacheGet<KlavisCatalogServer[]>(KLAVIS_CATALOG_CACHE_KEY)
  if (hit) return hit
  const catalog = await new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'sublime' }).listServerCatalog()
  if (catalog.length) await cacheSet(KLAVIS_CATALOG_CACHE_KEY, catalog, KLAVIS_CATALOG_TTL_MS)
  return catalog
}

/**
 * Klavis providers the workspace CAN connect but hasn't yet — the flow builder's
 * "browse available connectors" surface. Tools come from the live catalog (real
 * names + descriptions, no instance needed); a provider whose catalog entry
 * lacks tool detail falls back to the curated `PROVIDER_CAPABILITIES` list.
 *
 * Nango's browsable delivery capabilities (slack/gmail/salesforce) are all also
 * Klavis providers with richer tool sets, so listing "available Nango" would
 * only duplicate a richer Klavis row — available-browse is Klavis-only.
 */
async function loadAvailableKlavisConnectors(
  connectedProviders: Set<string>,
  takeTools?: number,
): Promise<FlowToolCatalogConnection[]> {
  const catalog = await fetchKlavisCatalog().catch(() => [] as KlavisCatalogServer[])
  return buildAvailableKlavisConnectors(catalog, connectedProviders, takeTools)
}

/**
 * Pure catalog→connectors mapping (no I/O), exported for tests: given the live
 * Klavis catalogue and the providers already connected, produce the browsable
 * "available to connect" entries.
 */
export function buildAvailableKlavisConnectors(
  catalog: KlavisCatalogServer[],
  connectedProviders: Set<string>,
  takeTools?: number,
): FlowToolCatalogConnection[] {
  if (!catalog.length) return []
  const byLiveName = new Map(catalog.map((server) => [server.name.toLowerCase(), server]))

  return PROVIDERS.flatMap((provider) => {
    if (connectedProviders.has(provider)) return []
    const capability = PROVIDER_CAPABILITIES[provider]
    const entry = byLiveName.get(capability.klavisName.toLowerCase())
    if (!entry) return [] // provider not enabled on this Klavis account
    // Live tool detail when present; otherwise the curated capability list.
    const source = entry.tools?.length ? entry.tools : capability.tools
    const tools = source.slice(0, takeTools ?? source.length).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: null,
      outputSchema: null,
      schemaHash: NULL_SCHEMA_HASH,
      risk: riskFor(tool.name, false),
    }))
    return [{
      // Browse-only id — never stored in a graph. Picking one connects first,
      // then inserts the resolved `klavis:<mcpAgentId>` id (see the picker).
      id: formatFlowToolConnectionId('klavis', `available:${provider}`),
      // Same label the connected Klavis entry uses (fromKlavisAgentType) so the
      // picker can match a just-connected provider back to its new row by name.
      name: fromKlavisAgentType(provider).label,
      tools,
      connected: false as const,
      connect: { plane: 'klavis' as const, provider },
    }]
  })
}

export async function loadFlowToolCatalog(
  organizationId: string,
  options: { userId?: string; takeConnections?: number; takeTools?: number; connectionIds?: string[]; includeAvailable?: boolean } = {},
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
  const connected: FlowToolCatalogConnection[] = groups
    .filter((group) => !wantedIds || wantedIds.has(group.id))
    .map((group) => ({
      id: group.id,
      name: group.name,
      connected: true,
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

  // Browse surface: append Klavis providers the workspace can connect but
  // hasn't. Only for the unfiltered picker load — run/publish validation
  // (connectionIds) and copilot grounding stay connected-only.
  if (options.includeAvailable && !wanted && wantPlane('klavis')) {
    const connectedKlavis = new Set(klavis.map((group) => group.provider))
    const available = await loadAvailableKlavisConnectors(connectedKlavis, options.takeTools).catch(
      () => [] as FlowToolCatalogConnection[],
    )
    return [...connected, ...available]
  }
  return connected
}
