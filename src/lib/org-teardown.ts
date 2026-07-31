/**
 * Complete organization teardown: external resources first (best-effort),
 * then the graph, then the org row — whose FK cascades (completed in WS-R4
 * Task 1) delete every owned row. Each external leg is isolated: a Nango
 * outage must not block the DB delete.
 */

import { systemPrisma } from '@/lib/prisma'
import { captureError } from '@/lib/observability/sentry'
import { graphRagPersistent, getGraphRagStore } from '@/lib/rag/get-store'

export async function teardownOrganization(organizationId: string): Promise<{ nango: number; graphCleared: boolean }> {
  let nango = 0
  let graphCleared = false

  // systemPrisma: org teardown enumerates the org's own rows by org id — the
  // guard's org-scope requirement is satisfied semantically but these run
  // outside any authenticated request context.
  try {
    if (process.env.NANGO_SECRET_KEY) {
      const { getNangoClient, nangoDeadline } = await import('@/lib/nango/client')
      const client = getNangoClient()
      const connections = await systemPrisma.nangoConnection.findMany({ where: { organizationId } })
      for (const connection of connections) {
        try {
          await nangoDeadline(client.deleteConnection(connection.providerConfigKey, connection.connectionId), undefined, 'nango deleteConnection')
          nango += 1
        } catch (error) {
          captureError(error, { source: 'orgTeardown.nango', organizationId, connectionId: connection.connectionId })
        }
      }
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.nangoLeg', organizationId })
  }

  try {
    if (graphRagPersistent()) {
      await getGraphRagStore().clear?.(organizationId)
      graphCleared = true
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.graph', organizationId })
  }

  await systemPrisma.organization.delete({ where: { id: organizationId } })
  return { nango, graphCleared }
}
