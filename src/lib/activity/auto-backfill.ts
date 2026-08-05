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
const NANGO_BACKFILL_SOURCES = new Set(['github', 'google_calendar', 'hubspot'])

export function autoBackfillSource(providerConfigKey: string): string | null {
  const slug = canonicalIntegrationSlug(providerConfigKey)
  if (!NANGO_BACKFILL_SOURCES.has(slug)) return null
  return getActivitySource(slug)?.capabilities.backfill ? slug : null
}

/** Slack rides the same window as the Nango sources — a divergence would show
 *  up later as inconsistent windowDays across an org's process baselines. */
export const SLACK_BACKFILL_WINDOW: BackfillWindow = AUTO_BACKFILL_WINDOW

/**
 * Slack's connect path is its own (a token save, not Nango status polling), so
 * it gets a trigger keyed on the workspace connection id its adapter actually
 * resolves.
 *
 * Guarded against re-entry: that route UPSERTS on every token save, and
 * startActivityBackfill resets cursor and eventsIngested, so an unguarded call
 * would restart a 90-day pull from zero every time someone re-saved their
 * credentials. Only the first connect starts the backfill; a genuine re-pull
 * is a deliberate action through the backfill panel.
 *
 * Never throws — a failed backfill start must not fail the connect.
 */
export async function triggerSlackBackfill(organizationId: string, workspaceConnectionId: string): Promise<void> {
  const adapter = getActivitySource('slack')
  if (!adapter?.capabilities.backfill) return
  try {
    const { prisma } = await import('@/lib/prisma')
    const existing = await prisma.activityBackfill.findUnique({
      where: {
        organizationId_source_connectionRef: {
          organizationId,
          source: 'slack',
          connectionRef: workspaceConnectionId,
        },
      },
      select: { id: true },
    })
    if (existing) return

    const { backfillId, mode } = await startActivityBackfill({
      organizationId,
      source: 'slack',
      connectionRef: workspaceConnectionId,
      window: SLACK_BACKFILL_WINDOW,
    })
    apiLogger.info('auto-backfill: slack started on connect', { organizationId, backfillId, mode })
  } catch (error) {
    apiLogger.warn('auto-backfill: slack start failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
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
