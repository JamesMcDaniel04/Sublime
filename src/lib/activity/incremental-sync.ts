/**
 * Daily incremental-sync sweep — the freshness leg of the activity ledger.
 * Backfill learns history once at connect; this keeps the ledger (and
 * everything downstream: usage-evidence gate, persona weights, patterns)
 * tracking reality afterwards for sources with no live event path.
 *
 * Slack is deliberately absent: its webhook leg already ingests live events,
 * and a sync would double-route them. Only sources whose adapter declares
 * `incrementalSync` and has no webhook leg participate (github,
 * google_calendar, hubspot).
 *
 * `since` derives from the ledger itself (latest event per org+source, with a
 * 1h overlap; 7d floor on first run) — no new checkpoint state, and the
 * dedupeKey contract makes any overlap a no-op.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { canonicalIntegrationSlug } from '@/lib/templates/departments'
import { listActivitySources } from './registry'
import { ingestActivity } from './ingest'

const OVERLAP_MS = 60 * 60 * 1000
const FIRST_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ORGS_PER_SWEEP = 200

export type IncrementalSyncStats = {
  organizationId: string
  sources: Record<string, { connections: number; ingested: number }>
}

/** Adapters that participate in the sweep: incremental-capable, webhook-less. */
export function sweepSources(): string[] {
  return listActivitySources()
    .filter((source) => source.capabilities.incrementalSync && !source.capabilities.webhooks)
    .map((source) => source.source)
}

// systemPrisma: cron-only sweep (CRON_SECRET-gated); every query stays org-scoped.
export async function runIncrementalSync(organizationId: string, db = systemPrisma): Promise<IncrementalSyncStats> {
  const stats: IncrementalSyncStats = { organizationId, sources: {} }
  const bySource = new Map(listActivitySources().map((source) => [source.source, source]))
  try {
    const connections = await db.nangoConnection.findMany({
      where: { organizationId, status: 'connected' },
      select: { connectionId: true, providerConfigKey: true },
    })
    const wanted = new Set(sweepSources())
    for (const connection of connections) {
      const sourceName = canonicalIntegrationSlug(connection.providerConfigKey)
      if (!wanted.has(sourceName)) continue
      const source = bySource.get(sourceName)
      if (!source) continue

      const latest = await db.activityEvent.findFirst({
        where: { organizationId, source: sourceName },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      })
      const since = latest
        ? new Date(latest.occurredAt.getTime() - OVERLAP_MS)
        : new Date(Date.now() - FIRST_RUN_WINDOW_MS)

      const events = await source.incrementalSync(
        { organizationId, connectionRef: connection.connectionId },
        since,
      )
      const created = await ingestActivity(organizationId, 'sync', events)
      const entry = stats.sources[sourceName] ?? { connections: 0, ingested: 0 }
      entry.connections += 1
      entry.ingested += created.length
      stats.sources[sourceName] = entry
    }
    if (Object.keys(stats.sources).length > 0) {
      apiLogger.info('activity.incremental-sync', stats as unknown as Record<string, unknown>)
    }
  } catch (error) {
    apiLogger.warn('activity.incremental-sync failed', {
      organizationId, error: error instanceof Error ? error.message : String(error),
    })
  }
  return stats
}

/** All orgs holding at least one sweep-eligible connection, capped. */
export async function sweepIncrementalSync(db = systemPrisma): Promise<void> {
  const rows = await db.nangoConnection.findMany({
    where: { status: 'connected' },
    select: { organizationId: true, providerConfigKey: true },
    take: 2_000,
  })
  const wanted = new Set(sweepSources())
  const orgs = new Set<string>()
  for (const row of rows) {
    if (wanted.has(canonicalIntegrationSlug(row.providerConfigKey))) orgs.add(row.organizationId)
    if (orgs.size >= MAX_ORGS_PER_SWEEP) break
  }
  for (const organizationId of orgs) {
    await runIncrementalSync(organizationId, db)
  }
}
