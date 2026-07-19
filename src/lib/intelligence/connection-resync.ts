import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { scanConnection } from './connection-scan'
import { capabilityForProviderConfigKey } from '@/lib/nango/delivery'
import { fromNangoProviderKey } from '@/lib/connectors/registry'

/**
 * Live knowledge sync, the periodic leg: connections are scanned when they
 * first connect, but a profile captured once and never refreshed goes stale as
 * the org's usage evolves. This sweep re-scans connections whose
 * `connection_profile` knowledge doc hasn't synced within the freshness
 * window (or that never produced one), keeping "live sync" true for every
 * connected tool — not just webhook-bearing sources like Slack.
 *
 * Bounded: at most `maxScans` connections per sweep, each scan itself bounded
 * (tool caps + timeouts inside scanConnection). Callers gate the cadence
 * (the dispatch cron runs it once a day).
 */

const RESYNC_DAYS_DEFAULT = 7

function resyncCutoff(): Date {
  const days = Number(process.env.CONNECTION_RESYNC_DAYS)
  const window = Number.isFinite(days) && days > 0 ? days : RESYNC_DAYS_DEFAULT
  return new Date(Date.now() - window * 24 * 60 * 60 * 1000)
}

type Candidate = {
  organizationId: string
  userId: string | null
  plane: 'nango' | 'mcp'
  connectionRef: string
  connectionName: string
}

export async function resyncStaleConnections(maxScans = 10): Promise<{ checked: number; rescanned: number }> {
  const cutoff = resyncCutoff()

  // systemPrisma: global freshness sweep — enumerates connections across all
  // orgs by design (invoked only from the CRON_SECRET-gated dispatch tick).
  const [mcpConnections, nangoConnections] = await Promise.all([
    systemPrisma.mcpConnection.findMany({
      where: { isActive: true },
      select: { id: true, organizationId: true, userId: true, name: true },
      take: 500,
    }),
    systemPrisma.nangoConnection.findMany({
      where: { status: 'connected' },
      select: { organizationId: true, userId: true, providerConfigKey: true },
      take: 500,
    }),
  ])

  const candidates: Candidate[] = [
    ...mcpConnections.map((connection) => ({
      organizationId: connection.organizationId,
      userId: connection.userId,
      plane: 'mcp' as const,
      connectionRef: connection.id,
      connectionName: connection.name,
    })),
    ...nangoConnections.flatMap((connection) => {
      const capability = capabilityForProviderConfigKey(connection.providerConfigKey)
      if (!capability) return []
      return [{
        organizationId: connection.organizationId,
        userId: connection.userId,
        plane: 'nango' as const,
        connectionRef: capability,
        connectionName: fromNangoProviderKey(connection.providerConfigKey).label,
      }]
    }),
  ]
  if (candidates.length === 0) return { checked: 0, rescanned: 0 }

  // One query for every candidate's profile doc; a doc synced inside the
  // window means the connection is fresh and skipped this sweep.
  // systemPrisma: id-keyed lookup across the orgs enumerated above.
  const freshDocs = await systemPrisma.knowledgeDocument.findMany({
    where: {
      sourceType: 'connection_profile',
      sourceId: { in: candidates.map((c) => `${c.plane}:${c.connectionRef}`) },
      lastSyncedAt: { gte: cutoff },
    },
    select: { organizationId: true, sourceId: true },
  })
  const fresh = new Set(freshDocs.map((doc) => `${doc.organizationId}|${doc.sourceId}`))

  const stale = candidates.filter((c) => !fresh.has(`${c.organizationId}|${c.plane}:${c.connectionRef}`))
  let rescanned = 0
  for (const candidate of stale.slice(0, maxScans)) {
    try {
      const result = await scanConnection(candidate)
      if ('scanned' in result && result.scanned) rescanned += 1
    } catch (error) {
      apiLogger.warn('connection resync: scan failed', {
        organizationId: candidate.organizationId,
        plane: candidate.plane,
        connectionRef: candidate.connectionRef,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (stale.length > maxScans) {
    apiLogger.info('connection resync: capped this sweep', { stale: stale.length, maxScans })
  }
  return { checked: candidates.length, rescanned }
}
