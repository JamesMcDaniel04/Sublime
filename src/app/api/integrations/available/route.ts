import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { granolaConfigured } from '@/lib/integrations/granola'
import {
  BUILTIN_CONNECTORS,
  fromNangoProviderKey,
} from '@/lib/connectors/registry'

/**
 * GET /api/integrations/available
 *
 * Every tool the org can attach to an agent, unified across planes so the
 * create-agent form shows what's ACTUALLY configured (not just env builtins):
 *  - `tools`: a deduped, logo-tagged list merging built-ins (Slack/Email/
 *    Granola) and Nango-connected accounts.
 *    Each `key` is the string the agent runtime matches — both this endpoint
 *    and loadTools derive keys/matching from the shared connector registry, so
 *    a chip the UI shows is a chip the runtime activates.
 *  - `connections`: the org's custom Sublime-MCP connections (id + name),
 *    which the runtime loads for every agent regardless of selection.
 *
 * Connection state is read from the mirror table (nango_connections) — the
 * same source the runtime uses — so this stays a fast DB read with no
 * external Nango round-trips.
 */

type ToolChip = { key: string; label: string; slug: string; connected: boolean }

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organizationId = auth.organizationId
  const [connections, hasGranola, nango, postgresCount] = await Promise.all([
    prisma.mcpConnection.findMany({
      where: {
        organizationId,
        isActive: true,
        OR: [{ userId: auth.dbUser.id }, { userId: null, provider: { not: null } }],
      },
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
    }),
    granolaConfigured(organizationId),
    prisma.nangoConnection.findMany({
      where: { organizationId, status: 'connected' },
      select: { providerConfigKey: true },
    }),
    prisma.postgresConnection.count({ where: { organizationId } }),
  ])

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

  // Postgres: one chip for the plane, connected once the org has any database.
  // The runtime resolves WHICH databases from the agent's selection, so the
  // picker stays a single chip rather than one per database.
  const postgres = BUILTIN_CONNECTORS.find((c) => c.providerId === 'postgres')
  if (postgres) {
    add({ key: postgres.key, label: postgres.label, slug: postgres.slug, connected: postgresCount > 0 })
  }

  for (const c of nango) {
    const m = fromNangoProviderKey(c.providerConfigKey)
    add({ ...m, connected: true })
  }

  // Connected first, then alphabetical, so the user's real tools lead.
  const tools = [...byKey.values()].sort((a, b) =>
    a.connected === b.connected ? a.label.localeCompare(b.label) : a.connected ? -1 : 1,
  )

  return {
    success: true,
    tools,
    connections: connections.map((c) => ({ id: c.id, name: c.name })),
  }
})
