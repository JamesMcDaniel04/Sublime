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
    // The immutable ledger remains the replay source; this encrypted document
    // makes the same activity searchable by agents immediately.
    void import('@/lib/knowledge/capture')
      .then(({ captureActivityKnowledge }) => captureActivityKnowledge(organizationId, created))
      .catch((error) => apiLogger.warn('activity.knowledge capture failed', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      }))
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
