import { cacheGet, cacheSet } from '@/lib/cache'
import { getOrgStrataConnection, getStrataServerNames } from '@/lib/mcp/strata'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

/**
 * GET /api/mcp/strata-catalog
 *
 * The org's Klavis Strata tool catalogue. When the org has an active MCP
 * connection to Klavis Strata (strata.klavis.ai — one endpoint aggregating all
 * of the account's tools, team-authorized), this returns every server behind
 * it, enriched with descriptions/tool counts from Klavis's public catalog.
 * All of them are usable by every agent via Strata's progressive-discovery
 * meta-tools, so they all report connected.
 *
 * Returns { strata: false } when no Strata connection exists — the UI then
 * falls back to the legacy per-provider Klavis cards (popup OAuth flow), so a
 * fresh workspace that hasn't set up Strata still has a working connect path.
 */

type CatalogEntry = { name: string; description?: string; toolCount?: number }

// Klavis's public server catalog (names/descriptions) is static; cache 24h.
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
const CATALOG_CACHE_KEY = 'klavis:server-catalog:v1'

async function klavisCatalog(): Promise<Map<string, CatalogEntry>> {
  const cached = await cacheGet<CatalogEntry[]>(CATALOG_CACHE_KEY)
  let entries = cached
  if (!entries) {
    const apiKey = process.env.KLAVIS_API_KEY
    if (!apiKey) return new Map()
    try {
      const response = await fetch('https://api.klavis.ai/mcp-server/servers', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return new Map()
      const data = (await response.json()) as { servers?: Array<{ name?: string; description?: string; tools?: unknown[] }> }
      entries = (data.servers ?? [])
        .filter((s) => typeof s.name === 'string' && s.name)
        .map((s) => ({
          name: s.name as string,
          // First sentence only — the raw descriptions run several lines.
          description: (s.description || '').split(/(?<=\.)\s/)[0]?.slice(0, 160) || undefined,
          toolCount: Array.isArray(s.tools) ? s.tools.length : undefined,
        }))
      await cacheSet(CATALOG_CACHE_KEY, entries, CATALOG_TTL_MS)
    } catch {
      return new Map()
    }
  }
  return new Map(entries.map((e) => [e.name.toLowerCase(), e]))
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  // The org's Strata connection, if one exists (created on the MCP Servers page).
  const connection = await getOrgStrataConnection(auth.organizationId)
  if (!connection) return { success: true, strata: false as const, servers: [] }

  const serverNames = await getStrataServerNames(connection)
  if (!serverNames.length) {
    return { success: true, strata: true as const, connectionName: connection.name, servers: [], error: 'Could not reach the Strata endpoint.' }
  }

  const catalog = await klavisCatalog()
  const servers = serverNames
    .map((name) => {
      const entry = catalog.get(name.toLowerCase())
      return {
        name,
        label: entry?.name ?? name.replace(/\b\w/g, (c) => c.toUpperCase()),
        description: entry?.description,
        toolCount: entry?.toolCount,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  return { success: true, strata: true as const, connectionName: connection.name, servers }
})
