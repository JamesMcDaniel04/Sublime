/**
 * Auto-trigger historical backfill the moment a Nango connection goes
 * active — the "learn from usage history on connect" leg of the persona
 * pipeline. Only sources whose ActivitySource adapter keys its connectionRef
 * on the Nango connection id participate. Slack is deliberately excluded:
 * its adapter keys on SlackWorkspaceConnection.id and connects through the
 * Slack routes, never Nango status polling.
 */
import { apiLogger } from '@/lib/logger'
import { canonicalIntegrationSlug } from '@/lib/templates/departments'
import { getActivitySource } from './registry'
import { startActivityBackfill } from './backfill'
import type { BackfillWindow } from './types'

export const AUTO_BACKFILL_WINDOW: BackfillWindow = '90d'

/** Sources safe to auto-backfill from a Nango connection id. google_calendar
 *  rides here too: its mirror row's connectionId is the GoogleOAuthConnection
 *  id, which is exactly what its adapter keys on. */
const NANGO_BACKFILL_SOURCES = new Set(['github', 'google_calendar'])

export function autoBackfillSource(providerConfigKey: string): string | null {
  const slug = canonicalIntegrationSlug(providerConfigKey)
  if (!NANGO_BACKFILL_SOURCES.has(slug)) return null
  return getActivitySource(slug)?.capabilities.backfill ? slug : null
}

export async function triggerAutoBackfills(
  organizationId: string,
  entries: { connectionId: string; providerConfigKey: string }[],
): Promise<void> {
  for (const entry of entries) {
    const source = autoBackfillSource(entry.providerConfigKey)
    if (!source) continue
    try {
      const { backfillId, mode } = await startActivityBackfill({
        organizationId,
        source,
        connectionRef: entry.connectionId,
        window: AUTO_BACKFILL_WINDOW,
      })
      apiLogger.info('auto-backfill: started on connect', { organizationId, source, backfillId, mode })
    } catch (error) {
      apiLogger.warn('auto-backfill: start failed', {
        organizationId,
        source,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
