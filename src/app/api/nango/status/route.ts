import type { Prisma } from '@prisma/client'
import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getNangoClient, nangoConfigured, NANGO_ORG_TAG } from '@/lib/nango/client'
import { googleOAuthConfigured } from '@/lib/google/oauth'
import { nangoApiError } from '@/lib/nango/errors'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { scanConnection, shouldScanNangoConnection, purgeConnectionLearnings } from '@/lib/intelligence/connection-scan'
import { capabilityForProviderConfigKey, capabilitiesToPurgeOnDisconnect, type DeliveryCapability } from '@/lib/nango/delivery'
import { fromNangoProviderKey } from '@/lib/connectors/registry'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'

type ConnectionStatus = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
  /** True when the entry is a native Google OAuth connection (not Nango). */
  native?: boolean
}

/** Marker written by src/lib/google/store.ts on mirror rows. */
const GOOGLE_NATIVE_PROVIDER = 'google-native'

async function mirroredConnectionStatus(organizationId: string, userId: string): Promise<Record<string, ConnectionStatus>> {
  const rows = await prisma.nangoConnection.findMany({
    where: { organizationId, userId },
    select: {
      connectionId: true,
      providerConfigKey: true,
      provider: true,
      status: true,
      lastError: true,
      updatedAt: true,
    },
  })
  const connections: Record<string, ConnectionStatus> = {}
  for (const row of rows) {
    const existing = connections[row.providerConfigKey]
    const connected = row.status === 'connected'
    connections[row.providerConfigKey] = {
      connected: existing ? existing.connected || connected : connected,
      connectionIds: [...(existing?.connectionIds ?? []), row.connectionId],
      provider: row.provider || row.providerConfigKey,
      error: existing?.error ?? row.lastError ?? undefined,
      lastSync: row.updatedAt.toISOString(),
      native: (existing?.native ?? false) || row.provider === GOOGLE_NATIVE_PROVIDER,
    }
  }
  return connections
}

// Lists the organization's Nango connections (live from Nango) and mirrors
// them into the per-org nango_connections table. Nango owns the credentials;
// we only persist connection ids and health.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  // Without Nango there is nothing to reconcile against the cloud — the
  // mirror (which includes native Google rows) IS the status.
  if (!nangoConfigured()) {
    return {
      success: true,
      connections: await mirroredConnectionStatus(auth.organizationId, auth.dbUser.id),
      nativeGoogle: googleOAuthConfigured(),
    }
  }

  const previousByConnectionId = new Map(
    (
      await prisma.nangoConnection.findMany({
        where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
        select: { connectionId: true, status: true },
      })
    ).map((row) => [row.connectionId, { status: row.status }]),
  )

  let response
  try {
    response = await getNangoClient().listConnections({
      tags: { [NANGO_ORG_TAG]: auth.organizationId },
    })
  } catch (error) {
    const normalized = nangoApiError(error)
    apiLogger.warn('nango status unavailable; serving the existing connection mirror', {
      organizationId: auth.organizationId,
      error: normalized.message,
    })
    return {
      success: true,
      connections: await mirroredConnectionStatus(auth.organizationId, auth.dbUser.id),
      nativeGoogle: googleOAuthConfigured(),
      stale: true,
      warning: 'Live connection status is temporarily unavailable. Showing the last known status.',
    }
  }

  const connections: Record<string, ConnectionStatus> = {}
  const seen: string[] = []

  // This route re-mirrors every Nango connection on every integrations page
  // load — only fire a scan on a genuine new-or-error→connected transition,
  // so a repeat page view doesn't re-scan an already-known-connected
  // connection. Keyed on the pre-update status (not mere row presence) so a
  // connection first mirrored while erroring/pending still scans once it
  // later reports connected.
  const newlyConnected: { connectionId: string; providerConfigKey: string; userId: string | null }[] = []

  for (const connection of response.connections ?? []) {
    const endUser = connection.end_user
    // Nango's org tag discovers the workspace catalog, but credentials remain
    // user-owned. Accept this session's end-user connections plus previously
    // mirrored legacy rows already assigned to this user; never mirror or
    // expose another member's OAuth account to a super admin.
    if (endUser?.id !== auth.dbUser.id && !previousByConnectionId.has(connection.connection_id)) continue

    seen.push(connection.connection_id)
    const errors = connection.errors ?? []
    const connected = errors.length === 0
    const error = connected ? undefined : `Connection needs attention (${errors[0].type})`
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
        userId: auth.dbUser.id,
        providerConfigKey: key,
        provider: connection.provider,
        status: connected ? 'connected' : 'error',
        lastError: error ?? null,
        metadata,
      },
      create: {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        connectionId: connection.connection_id,
        providerConfigKey: key,
        provider: connection.provider,
        status: connected ? 'connected' : 'error',
        lastError: error ?? null,
        metadata,
      },
    })

    if (shouldScanNangoConnection(previousByConnectionId.get(connection.connection_id), connected)) {
      newlyConnected.push({ connectionId: connection.connection_id, providerConfigKey: key, userId: auth.dbUser.id })
    }
  }

  // Purge-on-disconnect (Task 5, Fix B2): a connection that vanished from
  // Nango without going through the explicit DELETE route below (removed
  // directly in the Nango dashboard, expired, etc.) must still purge its
  // scan-derived learnings. Capture the about-to-be-dropped rows'
  // capabilities BEFORE the sweep removes them.
  // Native Google rows never appear in Nango's listing — the sweep must not
  // treat them as vanished (their lifecycle is the /api/google/oauth routes).
  const notNative = { OR: [{ provider: null }, { provider: { not: GOOGLE_NATIVE_PROVIDER } }] }
  const stale = await prisma.nangoConnection.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, connectionId: { notIn: seen }, ...notNative },
    select: { providerConfigKey: true },
  })
  const staleCapabilities = [
    ...new Set(stale.map((row) => capabilityForProviderConfigKey(row.providerConfigKey)).filter((c): c is DeliveryCapability => Boolean(c))),
  ]

  // Drop mirror rows for connections that no longer exist in Nango.
  await prisma.nangoConnection.deleteMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, connectionId: { notIn: seen }, ...notNative },
  })

  const organizationId = auth.organizationId

  // Reconcile: only purge a capability that NO remaining connected Nango
  // connection still maps to (see capabilitiesToPurgeOnDisconnect) — the
  // rows just upserted above already reflect this request's latest state.
  if (staleCapabilities.length > 0) {
    const stillConnectedRows = await prisma.nangoConnection.findMany({
      where: { organizationId, userId: auth.dbUser.id, status: 'connected' },
      select: { providerConfigKey: true },
    })
    const stillConnectedCapabilities = [
      ...new Set(stillConnectedRows.map((row) => capabilityForProviderConfigKey(row.providerConfigKey)).filter((c): c is DeliveryCapability => Boolean(c))),
    ]
    const toPurge = capabilitiesToPurgeOnDisconnect(staleCapabilities, stillConnectedCapabilities)
    if (toPurge.length > 0) {
      after(() =>
        Promise.all(
          toPurge.map((capability) => purgeConnectionLearnings({ organizationId, plane: 'nango', connectionRef: capability })),
        ).catch(() => undefined),
      )
    }
  }

  // Fire-and-forget usage scans for freshly-mirrored connections that map to
  // a known delivery capability (the only ones the scan plane can sample).
  // `after` (Next 15) so the scan survives past the response on serverless.
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

  // Merge native Google connections (mirror-only; invisible to Nango's API).
  const nativeRows = await prisma.nangoConnection.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, provider: GOOGLE_NATIVE_PROVIDER },
  })
  for (const row of nativeRows) {
    const existing = connections[row.providerConfigKey]
    const connected = row.status === 'connected'
    connections[row.providerConfigKey] = {
      connected: existing ? existing.connected || connected : connected,
      connectionIds: [...(existing?.connectionIds ?? []), row.connectionId],
      provider: row.provider ?? row.providerConfigKey,
      error: existing?.error ?? row.lastError ?? undefined,
      lastSync: row.updatedAt.toISOString(),
      native: true,
    }
  }

  return { success: true, connections, nativeGoogle: googleOAuthConfigured() }
})
