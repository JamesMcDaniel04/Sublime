/**
 * Postgres goal-metric source: a single-number reading from a SQL query.
 *
 * The connection handling and statement policy this source pioneered now live
 * in `@/lib/postgres`, shared with the agent/flow tool plane and the
 * intelligence scan so all three connect through one hardened implementation.
 * `buildClientConfig` and `validateReadOnlyQuery` are re-exported here because
 * this module was their original home.
 *
 * Two binding shapes resolve:
 *   - `postgres:<id>` — a PostgresConnection, the native integration
 *   - `credential:<id>` — a vault credential whose secret is a connection
 *     string. This predates the integration and stays supported so bindings
 *     created before it keep reading; new bindings use `postgres:`.
 */
import { prisma } from '@/lib/prisma'
import { credentialScope } from '@/lib/credentials/resolve'
import { decryptCredentialConfig } from '@/lib/credentials/config'
import { withReadOnlyTransaction, type CreatePgClient } from '@/lib/postgres/client'
import { validateReadOnlyQuery } from '@/lib/postgres/sql-policy'
import { resolvePostgresConnection } from '@/lib/postgres/connections'
import { parseSheetNumber } from './google-sheets'
import type {
  MetricDescriptor,
  MetricReading,
  MetricSource,
  MetricSourceContext,
} from '../types'
import { refId } from '../types'

export { buildClientConfig, safeError } from '@/lib/postgres/client'
export { validateReadOnlyQuery }

const METRICS: MetricDescriptor[] = [
  { key: 'postgres.query', label: 'SQL query result', unit: 'count' },
]

export function parsePostgresNumber(value: unknown): number {
  const parsed = parseSheetNumber([[value]])
  if (parsed === null) throw new Error('Postgres query did not return a numeric first column.')
  return parsed
}

type Connection = { connectionString: string; caCert?: string }
type ResolveConnection = (ctx: MetricSourceContext) => Promise<Connection>

/** Load the credential-vault form of a Postgres binding (pre-integration). */
async function resolveVaultCredential(ctx: MetricSourceContext): Promise<Connection> {
  const id = refId(ctx.connectionRef, 'credential')
  const credential = await prisma.credential.findFirst({
    where: { id, ...credentialScope(ctx.organizationId, ctx.userId) },
    select: { type: true, authConfig: true },
  })
  if (!credential) {
    throw new Error('Postgres credential is unavailable — check Settings → Credentials.')
  }
  const decrypted = decryptCredentialConfig(credential.type, credential.authConfig)
  const connectionString = decrypted.token ?? decrypted.key
  if (!connectionString) {
    throw new Error('Postgres credential must store its connection string as the token or key.')
  }
  return { connectionString, ...(decrypted.caCert ? { caCert: decrypted.caCert } : {}) }
}

async function resolveConnection(ctx: MetricSourceContext): Promise<Connection> {
  if (ctx.connectionRef?.startsWith('postgres:')) {
    const connection = await resolvePostgresConnection(ctx.organizationId, refId(ctx.connectionRef, 'postgres'))
    return { connectionString: connection.connectionString, ...(connection.caCert ? { caCert: connection.caCert } : {}) }
  }
  return resolveVaultCredential(ctx)
}

export function makePostgresMetricSource(deps?: {
  resolve?: ResolveConnection
  createClient?: CreatePgClient
}): MetricSource {
  const resolve = deps?.resolve ?? resolveConnection
  return {
    source: 'postgres',
    availableMetrics: () => METRICS,
    async fetchValue(ctx, metricKey): Promise<MetricReading> {
      if (metricKey !== 'postgres.query') {
        throw new Error(`Unknown Postgres metric '${metricKey}'`)
      }
      const query =
        typeof ctx.config.query === 'string' ? validateReadOnlyQuery(ctx.config.query) : ''
      if (!query) throw new Error('Postgres binding needs a query.')
      const connection = await resolve(ctx)
      const result = await withReadOnlyTransaction(
        { ...connection, ...(deps?.createClient ? { createClient: deps.createClient } : {}) },
        (client) => client.query(query),
      )
      if (result.rows.length === 0) throw new Error('Postgres query returned no rows.')
      const firstRow = result.rows[0]
      const firstValue = firstRow[Object.keys(firstRow)[0]]
      return { value: parsePostgresNumber(firstValue), asOf: new Date() }
    },
  }
}

export const postgresMetricSource = makePostgresMetricSource()
