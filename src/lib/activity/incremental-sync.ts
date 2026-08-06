/**
 * Incremental-sync sweep — the freshness leg of the activity ledger, run on
 * every dispatch tick. Backfill learns history once at connect; this keeps the
 * ledger (and everything downstream: usage-evidence gate, persona weights,
 * patterns) tracking reality afterwards for sources with no live event path.
 *
 * Slack is deliberately absent: its webhook leg already ingests live events,
 * and a sync would double-route them. Only sources whose adapter declares
 * `incrementalSync` and has no webhook leg participate (github,
 * google_calendar, hubspot).
 *
 * `since` derives from the ledger itself (latest event per org+source, with a
 * 1h overlap; 7d floor on first run) — no new checkpoint state, and the
 * dedupeKey contract makes any overlap a no-op. That idempotency is what makes
 * a per-tick cadence safe: each tick refetches at most the overlap window and
 * writes nothing it already has.
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
export function sweepSources(sources = listActivitySources()): string[] {
  return sources
    .filter((source) => source.capabilities.incrementalSync && !source.capabilities.webhooks)
    .map((source) => source.source)
}

// systemPrisma: cron-only sweep (CRON_SECRET-gated); every query stays org-scoped.
export async function runIncrementalSync(
  organizationId: string,
  db = systemPrisma,
  sources = listActivitySources(),
): Promise<IncrementalSyncStats> {
  const stats: IncrementalSyncStats = { organizationId, sources: {} }
  const bySource = new Map(sources.map((source) => [source.source, source]))
  const wanted = new Set(sweepSources(sources))

  const syncOne = async (sourceName: string, connectionRef: string) => {
    const source = bySource.get(sourceName)
    if (!source) return
    const latest = await db.activityEvent.findFirst({
      where: { organizationId, source: sourceName },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    })
    const since = latest
      ? new Date(latest.occurredAt.getTime() - OVERLAP_MS)
      : new Date(Date.now() - FIRST_RUN_WINDOW_MS)
    const events = await source.incrementalSync({ organizationId, connectionRef }, since)
    const created = await ingestActivity(organizationId, 'sync', events)
    const entry = stats.sources[sourceName] ?? { connections: 0, ingested: 0 }
    entry.connections += 1
    entry.ingested += created.length
    stats.sources[sourceName] = entry
  }

  try {
    const connections = await db.nangoConnection.findMany({
      where: { organizationId, status: 'connected' },
      select: { connectionId: true, providerConfigKey: true },
    })
    for (const connection of connections) {
      const sourceName = canonicalIntegrationSlug(connection.providerConfigKey)
      if (!wanted.has(sourceName)) continue
      await syncOne(sourceName, connection.connectionId)
    }

    // Granola authenticates via a per-org API key (IntegrationSecret), not a
    // Nango connection — enumerate it separately with its constant ref.
    if (wanted.has('granola')) {
      const granolaSecret = await db.integrationSecret.findFirst({
        where: { organizationId, provider: 'granola', isActive: true },
        select: { id: true },
      })
      if (granolaSecret) await syncOne('granola', 'granola')
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
export async function sweepIncrementalSync(db = systemPrisma, sources = listActivitySources()): Promise<void> {
  const [rows, granolaRows] = await Promise.all([
    db.nangoConnection.findMany({
      where: { status: 'connected' },
      select: { organizationId: true, providerConfigKey: true },
      take: 2_000,
    }),
    db.integrationSecret.findMany({
      where: { provider: 'granola', isActive: true },
      select: { organizationId: true },
      take: 500,
    }),
  ])
  const wanted = new Set(sweepSources(sources))
  const orgs = new Set<string>()
  let saturated = false
  for (const row of rows) {
    if (wanted.has(canonicalIntegrationSlug(row.providerConfigKey))) orgs.add(row.organizationId)
    if (orgs.size >= MAX_ORGS_PER_SWEEP) { saturated = true; break }
  }
  if (wanted.has('granola')) {
    for (const row of granolaRows) {
      if (orgs.size >= MAX_ORGS_PER_SWEEP) { saturated = true; break }
      orgs.add(row.organizationId)
    }
  }
  if (saturated) {
    // Never a silent cap: orgs past it stay a tick behind, not a day behind
    // (the sweep runs every tick), but the operator should see the pressure.
    apiLogger.warn('activity.incremental-sync: org cap saturated', { cap: MAX_ORGS_PER_SWEEP })
  }
  for (const organizationId of orgs) {
    await runIncrementalSync(organizationId, db, sources)
  }
}
