import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { revokeToken } from '@/lib/google/oauth'
import { deleteGoogleConnection } from '@/lib/google/store'
import {
  capabilitiesToPurgeOnDisconnect,
  capabilityForProviderConfigKey,
  type DeliveryCapability,
} from '@/lib/nango/delivery'
import { purgeConnectionLearnings } from '@/lib/intelligence/connection-scan'

export const runtime = 'nodejs'

/** Disconnects one native Google connection: best-effort revoke at Google,
 *  delete the record + its mirror row, purge scan learnings (same reconcile
 *  rules as the Nango disconnect route). */
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = decodeURIComponent(request.nextUrl.pathname.split('/').at(-1) ?? '')
  if (!id) throw new ApiError('Connection id is required')

  const deleted = await deleteGoogleConnection({ organizationId: auth.organizationId, id })
  if (!deleted) throw new ApiError('Connected account not found', 404, 'NOT_FOUND')
  if (deleted.refreshToken) await revokeToken(deleted.refreshToken)

  const organizationId = auth.organizationId
  const affectedCapability = capabilityForProviderConfigKey(deleted.service)
  if (affectedCapability) {
    const stillConnectedRows = await prisma.nangoConnection.findMany({
      where: { organizationId, status: 'connected' },
      select: { providerConfigKey: true },
    })
    const stillConnectedCapabilities = [
      ...new Set(
        stillConnectedRows
          .map((row) => capabilityForProviderConfigKey(row.providerConfigKey))
          .filter((c): c is DeliveryCapability => Boolean(c)),
      ),
    ]
    const toPurge = capabilitiesToPurgeOnDisconnect([affectedCapability], stillConnectedCapabilities)
    if (toPurge.length > 0) {
      // Purge is best-effort and must never block (or fail) the disconnect:
      // `after` throws outside a real request scope (e.g. the test harness).
      try {
        after(() =>
          Promise.all(
            toPurge.map((capability) => purgeConnectionLearnings({ organizationId, plane: 'nango', connectionRef: capability })),
          ).catch(() => undefined),
        )
      } catch {
        void Promise.all(
          toPurge.map((capability) => purgeConnectionLearnings({ organizationId, plane: 'nango', connectionRef: capability })),
        ).catch(() => undefined)
      }
    }
  }

  return { success: true }
}, { requires: 'member' })
