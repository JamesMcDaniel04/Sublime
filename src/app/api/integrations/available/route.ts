import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { granolaConfigured } from '@/lib/integrations/granola'
import { getUserStrataConnection, getStrataServerNames, isStrataUrl, STRATA_KEY_PREFIX } from '@/lib/mcp/strata'
import {
  BUILTIN_CONNECTORS,
  fromNangoProviderKey,
  fromKlavisAgentType,
} from '@/lib/connectors/registry'

/**
 * GET /api/integrations/available
 *
 * Every tool the org can attach to an agent, unified across planes so the
 * create-agent form shows what's ACTUALLY configured (not just env builtins):
 *  - `tools`: a deduped, logo-tagged list merging built-ins (Slack/Email/
 *    Granola), Nango-connected accounts, and Klavis-provisioned MCP servers.
 *    Each `key` is the string the agent runtime matches — both this endpoint
 *    and loadTools derive keys/matching from the shared connector registry, so
 *    a chip the UI shows is a chip the runtime activates.
 *  - `connections`: the org's custom Sublime-MCP connections (id + name),
 *    which the runtime loads for every agent regardless of selection.
 *
 * Connection state is read from the mirror tables (nango_connections,
 * mcp_agents) — the same source the runtime uses — so this stays a fast DB
 * read with no external Nango/Klavis round-trips.
 */

type ToolChip = { key: string; label: string; slug: string; connected: boolean }

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organizationId = auth.organizationId
  const [connectionsRaw, hasGranola, nango, klavis, strataConnection] = await Promise.all([
    prisma.mcpConnection.findMany({
      where: { organizationId, userId: auth.dbUser.id, isActive: true },
      select: { id: true, name: true, serverUrl: true },
      orderBy: { createdAt: 'desc' },
    }),
    granolaConfigured(organizationId),
    prisma.nangoConnection.findMany({
      where: { organizationId, userId: auth.dbUser.id, status: 'connected' },
      select: { providerConfigKey: true },
    }),
    prisma.mCPAgent.findMany({
      where: { organizationId, userId: auth.dbUser.id, isActive: true },
      select: { agentType: true },
    }),
    getUserStrataConnection(organizationId, auth.dbUser.id),
  ])

  // The Strata connection is surfaced as individual per-server chips below, not
  // as one opaque "connection" chip.
  const connections = connectionsRaw.filter((c) => !isStrataUrl(c.serverUrl))

  // Each Strata server is an attachable tool keyed `strata:<server>`. Selecting
  // some scopes the agent to only those (see loadTools); selecting none means
  // the agent gets no Strata tools — so agents no longer carry all 90 at once.
  const strataServers = strataConnection ? await getStrataServerNames(strataConnection) : []
  const strataTools: ToolChip[] = strataServers.map((name) => ({
    key: `${STRATA_KEY_PREFIX}${name}`,
    label: name.replace(/\b\w/g, (ch) => ch.toUpperCase()),
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
    connected: true,
  }))

  // Merge planes, deduping by lowercased key and OR-ing connected state. Builtins
  // are added first so their canonical labels/keys (Slack/Email/Granola) win.
  const byKey = new Map<string, ToolChip>()
  const add = (chip: ToolChip) => {
    const id = chip.key.toLowerCase()
    const existing = byKey.get(id)
    if (existing) existing.connected = existing.connected || chip.connected
    else byKey.set(id, chip)
  }

  // Built-in delivery/meeting planes, straight from the registry. Granola's
  // availability is per-org (an API key), the rest come from env via available().
  for (const c of BUILTIN_CONNECTORS) {
    if (c.kind !== 'builtin') continue
    // Resend email is redundant with Gmail delivery, so it's retired from the
    // picker. The registry entry stays so the runtime email plane still works
    // for any agent that already has it selected.
    if (c.providerId === 'email') continue
    add({ key: c.key, label: c.label, slug: c.slug, connected: c.key === 'Granola' ? hasGranola : c.available() })
  }

  for (const c of nango) {
    const m = fromNangoProviderKey(c.providerConfigKey)
    add({ ...m, connected: true })
  }
  for (const a of klavis) {
    const m = fromKlavisAgentType(a.agentType)
    add({ ...m, connected: true })
  }

  // Connected first, then alphabetical, so the user's real tools lead.
  const tools = [...byKey.values()].sort((a, b) =>
    a.connected === b.connected ? a.label.localeCompare(b.label) : a.connected ? -1 : 1,
  )

  return {
    success: true,
    tools,
    strataTools,
    connections: connections.map((c) => ({ id: c.id, name: c.name })),
  }
})
