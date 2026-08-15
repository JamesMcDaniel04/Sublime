import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { withElevatedAccess } from '@/lib/server/elevated'
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

  // A Google connection is a PERSONAL grant (the schema's unique key includes
  // userId). Disconnecting someone ELSE's account is a cross-owner act: owner
  // or audited admin elevation only — org scope alone let any member revoke a
  // colleague's grant.
  const record = await prisma.googleOAuthConnection.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, userId: true },
  })
  if (!record) throw new ApiError('Connected account not found', 404, 'NOT_FOUND')

  const performDelete = async () => {
    const deleted = await deleteGoogleConnection({ organizationId: auth.organizationId, id, actorUserId: auth.dbUser.id })
    if (!deleted) throw new ApiError('Connected account not found', 404, 'NOT_FOUND')
    if (deleted.refreshToken) await revokeToken(deleted.refreshToken)
    return deleted
  }

  const deleted =
    record.userId === auth.dbUser.id
      ? await performDelete()
      : await withElevatedAccess(
          auth,
          {
            action: 'admin.resource.update',
            resourceType: 'connection',
            resourceId: record.id,
            targetUserId: record.userId,
            detail: { plane: 'google', operation: 'disconnect' },
          },
          performDelete,
        )

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
