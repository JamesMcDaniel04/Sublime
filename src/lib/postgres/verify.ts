/**
 * Proving a Postgres connection works, and keeping the integrations grid in
 * sync with the result.
 *
 * The grid, `/api/nango/status`, and the org's connection mirror all read
 * `NangoConnection` rows. Rather than teach each of those about a fourth
 * connection type, a Postgres connection MIRRORS itself into that table with
 * `provider: 'postgres-native'` — the same trick native Google OAuth uses. The
 * mirror carries no secret: it is connection id, key, and health.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { recordVerification } from '@/lib/connections/record-verification'
import { formatFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { withReadOnlyTransaction } from './client'
import { resolvePostgresConnection } from './connections'

/** providerConfigKey used for every Postgres mirror row — one tile, N databases. */
export const POSTGRES_PROVIDER_KEY = 'postgres'
export const POSTGRES_NATIVE_PROVIDER = 'postgres-native'

/**
 * Mirror one connection's health into the grid's table.
 *
 * Best-effort: a lost mirror write must not fail the operation that triggered
 * it. The PostgresConnection row is the source of truth; the mirror is a
 * denormalized read model for surfaces that predate this integration.
 */
export async function upsertPostgresMirror(params: {
  organizationId: string
  connectionId: string
  name: string
  connected: boolean
  error?: string | null
}): Promise<void> {
  try {
    const data = {
      providerConfigKey: POSTGRES_PROVIDER_KEY,
      provider: POSTGRES_NATIVE_PROVIDER,
      status: params.connected ? 'connected' : 'error',
      lastError: params.error ?? null,
      metadata: { postgres: { connectionId: params.connectionId, name: params.name } },
    }
    await prisma.nangoConnection.upsert({
      where: {
        organizationId_connectionId: {
          organizationId: params.organizationId,
          connectionId: params.connectionId,
        },
      },
      update: data,
      // userId stays null: a database is org infrastructure, not a personal
      // OAuth account, so every member sees the same connection state.
      create: { organizationId: params.organizationId, connectionId: params.connectionId, ...data },
    })
  } catch (error) {
    apiLogger.warn('postgres mirror write failed', {
      organizationId: params.organizationId,
      connectionId: params.connectionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function deletePostgresMirror(organizationId: string, connectionId: string): Promise<void> {
  try {
    await prisma.nangoConnection.deleteMany({ where: { organizationId, connectionId } })
  } catch (error) {
    apiLogger.warn('postgres mirror delete failed', { organizationId, connectionId, error: String(error) })
  }
}

export type PostgresVerification = { ok: boolean; status: 'connected' | 'error'; error?: string }

/**
 * Open the connection, run the cheapest possible statement, and persist the
 * outcome everywhere it is read: the row's own status, the grid mirror, and
 * the shared `ConnectionVerification` table (keyed by the flow-catalog id, so
 * the flow builder's verification badge resolves it like any other plane).
 */
export async function verifyPostgresConnection(
  organizationId: string,
  connectionId: string,
): Promise<PostgresVerification> {
  let outcome: PostgresVerification
  let name = ''
  try {
    const connection = await resolvePostgresConnection(organizationId, connectionId)
    name = connection.name
    await withReadOnlyTransaction(
      {
        connectionString: connection.connectionString,
        ...(connection.caCert ? { caCert: connection.caCert } : {}),
      },
      (client) => client.query('SELECT 1'),
    )
    outcome = { ok: true, status: 'connected' }
  } catch (error) {
    // safeError has already stripped credentials out of driver messages.
    outcome = { ok: false, status: 'error', error: error instanceof Error ? error.message : String(error) }
  }

  await prisma.postgresConnection.updateMany({
    where: { id: connectionId, organizationId },
    data: { status: outcome.status, lastError: outcome.error ?? null },
  })
  await upsertPostgresMirror({
    organizationId,
    connectionId,
    name,
    connected: outcome.ok,
    error: outcome.error ?? null,
  })
  await recordVerification({
    organizationId,
    connectionId: formatFlowToolConnectionId('postgres', connectionId),
    state: outcome.ok ? 'verified' : 'failed',
    error: outcome.error ?? null,
  })
  return outcome
}
