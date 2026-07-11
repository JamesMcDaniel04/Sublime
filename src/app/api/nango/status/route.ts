import type { Prisma } from '@prisma/client'
import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getNangoClient, NANGO_ORG_TAG } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { scanConnection, shouldScanNangoConnection } from '@/lib/intelligence/connection-scan'
import { DELIVERY_PROVIDERS, type DeliveryCapability } from '@/lib/nango/delivery'
import { fromNangoProviderKey } from '@/lib/connectors/registry'

export const runtime = 'nodejs'

/** providerConfigKey (e.g. "google-mail") → the scan-plane delivery capability, if any. */
function capabilityForProviderConfigKey(providerConfigKey: string): DeliveryCapability | undefined {
  const entry = (Object.entries(DELIVERY_PROVIDERS) as [DeliveryCapability, readonly string[]][]).find(
    ([, keys]) => keys.includes(providerConfigKey),
  )
  return entry?.[0]
}

type ConnectionStatus = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
}

// Lists the organization's Nango connections (live from Nango) and mirrors
// them into the per-org nango_connections table. Nango owns the credentials;
// we only persist connection ids and health.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  let response
  try {
    response = await getNangoClient().listConnections({
      tags: { [NANGO_ORG_TAG]: auth.organizationId },
    })
  } catch (error) {
    throw nangoApiError(error)
  }

  const connections: Record<string, ConnectionStatus> = {}
  const seen: string[] = []

  // This route re-mirrors every Nango connection on every integrations page
  // load — only fire a scan on a genuine new-or-error→connected transition,
  // so a repeat page view doesn't re-scan an already-known-connected
  // connection. Keyed on the pre-update status (not mere row presence) so a
  // connection first mirrored while erroring/pending still scans once it
  // later reports connected.
  const previousByConnectionId = new Map(
    (
      await prisma.nangoConnection.findMany({
        where: { organizationId: auth.organizationId },
        select: { connectionId: true, status: true },
      })
    ).map((row) => [row.connectionId, { status: row.status }]),
  )
  const newlyConnected: { connectionId: string; providerConfigKey: string; userId: string | null }[] = []

  for (const connection of response.connections ?? []) {
    seen.push(connection.connection_id)
    const errors = connection.errors ?? []
    const connected = errors.length === 0
    const error = connected ? undefined : `Connection needs attention (${errors[0].type})`
    const endUser = connection.end_user
    const key = connection.provider_config_key

    const existing = connections[key]
    connections[key] = {
      connected: existing ? existing.connected || connected : connected,
      connectionIds: [...(existing?.connectionIds ?? []), connection.connection_id],
      provider: connection.provider,
      error: existing?.error ?? error,
      lastSync: connection.created,
    }

    const metadata = {
      nango: {
        connectionId: connection.connection_id,
        providerConfigKey: key,
        provider: connection.provider,
        endUserId: endUser?.id ?? null,
        errors,
      },
    } satisfies Prisma.InputJsonObject

    await prisma.nangoConnection.upsert({
      where: {
        organizationId_connectionId: {
          organizationId: auth.organizationId,
          connectionId: connection.connection_id,
        },
      },
      update: {
        providerConfigKey: key,
        provider: connection.provider,
        status: connected ? 'connected' : 'error',
        lastError: error ?? null,
        metadata,
      },
      create: {
        organizationId: auth.organizationId,
        userId: endUser?.id ?? null,
        connectionId: connection.connection_id,
        providerConfigKey: key,
        provider: connection.provider,
        status: connected ? 'connected' : 'error',
        lastError: error ?? null,
        metadata,
      },
    })

    if (shouldScanNangoConnection(previousByConnectionId.get(connection.connection_id), connected)) {
      newlyConnected.push({ connectionId: connection.connection_id, providerConfigKey: key, userId: endUser?.id ?? null })
    }
  }

  // Drop mirror rows for connections that no longer exist in Nango.
  await prisma.nangoConnection.deleteMany({
    where: { organizationId: auth.organizationId, connectionId: { notIn: seen } },
  })

  // Fire-and-forget usage scans for freshly-mirrored connections that map to
  // a known delivery capability (the only ones the scan plane can sample).
  // `after` (Next 15) so the scan survives past the response on serverless.
  const organizationId = auth.organizationId
  after(() =>
    Promise.all(
      newlyConnected.map(async ({ providerConfigKey, userId }) => {
        const capability = capabilityForProviderConfigKey(providerConfigKey)
        if (!capability) return
        await scanConnection({
          organizationId,
          userId,
          plane: 'nango',
          connectionRef: capability,
          connectionName: fromNangoProviderKey(providerConfigKey).label,
        })
      }),
    ).catch(() => undefined),
  )

  return { success: true, connections }
})
