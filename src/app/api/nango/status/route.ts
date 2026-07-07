import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getNangoClient, NANGO_ORG_TAG } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

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
  }

  // Drop mirror rows for connections that no longer exist in Nango.
  await prisma.nangoConnection.deleteMany({
    where: { organizationId: auth.organizationId, connectionId: { notIn: seen } },
  })

  return { success: true, connections }
})
