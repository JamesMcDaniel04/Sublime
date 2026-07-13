import { prisma } from '@/lib/prisma'
import { cacheGet, cacheSet } from '@/lib/cache'
import { McpClient, mcpConfigFromConnection } from './mcp-client'

/**
 * Klavis Strata helpers. Strata is one MCP endpoint (strata.klavis.ai) that
 * aggregates all of an account's tools behind six progressive-discovery
 * meta-tools. We surface the individual servers so users can attach only the
 * ones an agent needs (key `strata:<server>`), rather than exposing all of them
 * to every agent at once.
 */

export const STRATA_KEY_PREFIX = 'strata:'
export const isStrataUrl = (url: string) => /strata\.klavis\.ai/i.test(url)

const LIST_TTL_MS = 10 * 60 * 1000
const listKey = (connectionId: string) => `strata:servers:${connectionId}`

export type StrataConnection = { id: string; name: string; serverUrl: string; authType: string; authConfig: unknown }

/** The org's active Strata MCP connection, if one exists. */
export async function getOrgStrataConnection(organizationId: string): Promise<StrataConnection | null> {
  return prisma.mcpConnection.findFirst({
    where: { organizationId, isActive: true, serverUrl: { contains: 'strata.klavis.ai' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, serverUrl: true, authType: true, authConfig: true },
  })
}

/** The server names behind a Strata connection (e.g. "snowflake", "gmail"). */
export async function getStrataServerNames(connection: StrataConnection): Promise<string[]> {
  const cached = await cacheGet<string[]>(listKey(connection.id))
  if (cached) return cached
  try {
    const client = new McpClient(mcpConfigFromConnection(connection))
    const result = (await client.executeTool(connection.serverUrl, 'discover_server_categories_or_actions', {})) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = result?.content?.find((c) => c.type === 'text')?.text || '{}'
    const parsed = JSON.parse(text) as { servers?: Record<string, unknown> }
    const names = Object.keys(parsed.servers ?? {}).sort()
    if (names.length) await cacheSet(listKey(connection.id), names, LIST_TTL_MS)
    return names
  } catch {
    return []
  }
}

/** Pull the selected Strata server names out of an agent's connector keys. */
export function selectedStrataServers(connectorKeys: string[]): string[] {
  return connectorKeys
    .filter((k) => k.toLowerCase().startsWith(STRATA_KEY_PREFIX))
    .map((k) => k.slice(STRATA_KEY_PREFIX.length).trim())
    .filter(Boolean)
}
