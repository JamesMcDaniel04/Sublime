/**
 * Which connectable integrations a goal's metrics actually bind to.
 *
 * Two vocabularies have to be bridged, and neither is derivable from the other:
 *
 *   GoalMetric.source     'google_sheets' | 'stripe' | 'gmail_assisted' | ...
 *   catalog chip id       'google-sheets' | 'stripe' | 'google-mail'   | ...
 *
 * Note this maps on `source`, NOT `connectionRef`. connectionRef is
 * '<plane>:<id>' (see lib/metrics/types.ts) — an INSTANCE identifier — so
 * matching it against catalog ids would match nothing and silently empty every
 * scoped integrations page.
 *
 * Sources absent from the map bind to no connectable integration: 'manual' and
 * 'url' have no connection at all, and a goal built only from those correctly
 * shows an empty scoped catalog with the ratio explaining why.
 */

import { prisma } from '@/lib/prisma'

/** GoalMetric.source -> /api/nango/integrations chip id. */
const SOURCE_TO_INTEGRATION_ID: Record<string, string> = {
  stripe: 'stripe',
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  // Google services connect through the NATIVE OAuth flow, so their catalog
  // ids are the native tile ids rather than Nango provider keys.
  google_sheets: 'google-sheets',
  google_analytics: 'google-analytics',
  gmail_assisted: 'google-mail',
  postgres: 'postgres',
  slack_assisted: 'slack',
}

export async function goalIntegrationIds(organizationId: string, goalId: string): Promise<Set<string>> {
  const metrics = await prisma.goalMetric.findMany({
    where: { organizationId, goalId },
    select: { source: true },
  })
  const ids = new Set<string>()
  for (const metric of metrics) {
    const id = SOURCE_TO_INTEGRATION_ID[metric.source]
    if (id) ids.add(id)
  }
  return ids
}
