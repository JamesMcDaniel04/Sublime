/**
 * Complete organization teardown: external resources first (best-effort),
 * then the graph, then the org row — whose FK cascades (completed in WS-R4
 * Task 1) delete every owned row. Each external leg is isolated: a Klavis
 * outage must not strand Nango connections or block the DB delete.
 */

import { systemPrisma } from '@/lib/prisma'
import { captureError } from '@/lib/observability/sentry'
import { graphRagPersistent, getGraphRagStore } from '@/lib/rag/get-store'

export async function teardownOrganization(organizationId: string): Promise<{ klavis: number; nango: number; graphCleared: boolean }> {
  let klavis = 0
  let nango = 0
  let graphCleared = false

  // systemPrisma: org teardown enumerates the org's own rows by org id — the
  // guard's org-scope requirement is satisfied semantically but these run
  // outside any authenticated request context.
  try {
    if (process.env.KLAVIS_API_KEY) {
      const { KlavisClient } = await import('@/lib/mcp/klavis-client')
      const klavisClient = new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'sublime' })
      const mcpAgents = await systemPrisma.mCPAgent.findMany({ where: { organizationId } })
      for (const agent of mcpAgents) {
        const instanceId = (agent.metadata as { instanceId?: string } | null)?.instanceId
        if (!instanceId) continue
        try {
          await klavisClient.deleteServerInstance(instanceId)
          klavis += 1
        } catch (error) {
          captureError(error, { source: 'orgTeardown.klavis', organizationId, instanceId })
        }
      }
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.klavisLeg', organizationId })
  }

  try {
    if (process.env.NANGO_SECRET_KEY) {
      const { getNangoClient } = await import('@/lib/nango/client')
      const client = getNangoClient()
      const connections = await systemPrisma.nangoConnection.findMany({ where: { organizationId } })
      for (const connection of connections) {
        try {
          await client.deleteConnection(connection.providerConfigKey, connection.connectionId)
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
  return { klavis, nango, graphCleared }
}
