/** One best-effort funnel for live, sync, and backfilled activity. */
import { apiLogger } from '@/lib/logger'
import { persistActivity, type PersistedActivity } from './ledger'
import { indexActivity } from './index-activity'
import { routeActivityEvent } from './route-activity'
import type { IngestKind, NormalizedActivity } from './types'

export async function ingestActivity(
  organizationId: string,
  ingestKind: IngestKind,
  events: NormalizedActivity[],
): Promise<PersistedActivity[]> {
  if (events.length === 0) return []
  try {
    const { created } = await persistActivity(organizationId, ingestKind, events)
    await indexActivity(created)
    if (ingestKind !== 'backfill') {
      for (const event of created) await routeActivityEvent(event)
    }
    return created
  } catch (error) {
    apiLogger.warn('activity.ingest failed', {
      organizationId,
      ingestKind,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
