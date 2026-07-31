import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getNangoClient, nangoDeadline, NANGO_ORG_TAG } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { purgeConnectionLearnings } from '@/lib/intelligence/connection-scan'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { capabilityForProviderConfigKey, capabilitiesToPurgeOnDisconnect, type DeliveryCapability } from '@/lib/nango/delivery'

export const runtime = 'nodejs'

// Disconnects every org-scoped Nango connection for the given integration
// (provider config key), then removes the local mirror rows.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const integrationId = decodeURIComponent(request.nextUrl.pathname.split('/').at(-1) ?? '')
  if (!integrationId) throw new ApiError('Integration id is required')

  const client = getNangoClient()
  let response
  try {
    response = await nangoDeadline(client.listConnections({
      integrationId,
      tags: { [NANGO_ORG_TAG]: auth.organizationId },
    }), undefined, 'nango listConnections')
  } catch (error) {
    throw nangoApiError(error)
  }

  const matching = (response.connections ?? []).filter(
    (connection) => connection.provider_config_key === integrationId,
  )
  if (!matching.length) throw new ApiError('Connected account not found', 404, 'NOT_FOUND')

  try {
    await Promise.all(
      matching.map((connection) => client.deleteConnection(integrationId, connection.connection_id)),
    )
  } catch (error) {
    throw nangoApiError(error)
  }

  const organizationId = auth.organizationId
  await prisma.nangoConnection.deleteMany({
    where: {
      organizationId,
      connectionId: { in: matching.map((connection) => connection.connection_id) },
    },
  })

  // Pairs with connection_added (emitted on the Nango OAuth callback), so the
  // ledger reflects connectors that were dropped rather than assuming every
  // integration ever connected is still held.
  await recordUserEvent({
    organizationId, userId: auth.dbUser.id,
    kind: 'connection_removed', resourceType: 'connection', resourceId: integrationId,
    context: { provider: integrationId, plane: 'nango', count: matching.length },
  })

  // Best-effort purge of this capability's scan-derived learnings (Task 5,
  // Fix B2) — never blocks the disconnect response. Reconcile first: another
  // providerConfigKey can map to the same capability (e.g. "google-mail" and
  // "gmail" both → gmail), so only purge if NO remaining connected Nango
  // connection still maps to it. `after` (Next 15) keeps this running past
  // the response on serverless, same reasoning as the mcp disconnects.
  const affectedCapability = capabilityForProviderConfigKey(integrationId)
  if (affectedCapability) {
    const stillConnectedRows = await prisma.nangoConnection.findMany({
      where: { organizationId, status: 'connected' },
      select: { providerConfigKey: true },
    })
    const stillConnectedCapabilities = [
      ...new Set(stillConnectedRows.map((row) => capabilityForProviderConfigKey(row.providerConfigKey)).filter((c): c is DeliveryCapability => Boolean(c))),
    ]
    const toPurge = capabilitiesToPurgeOnDisconnect([affectedCapability], stillConnectedCapabilities)
    if (toPurge.length > 0) {
      after(() =>
        Promise.all(
          toPurge.map((capability) => purgeConnectionLearnings({ organizationId, plane: 'nango', connectionRef: capability })),
        ).catch(() => undefined),
      )
    }
  }

  return { success: true }
}, { requires: 'member' })
