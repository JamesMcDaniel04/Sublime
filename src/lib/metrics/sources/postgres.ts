import { Client, type ClientConfig, type QueryResult } from 'pg'
import { prisma } from '@/lib/prisma'
import { credentialScope } from '@/lib/credentials/resolve'
import { decryptCredentialConfig } from '@/lib/credentials/config'
import { parseSheetNumber } from './google-sheets'
import type {
  MetricDescriptor,
  MetricReading,
  MetricSource,
  MetricSourceContext,
} from '../types'
import { refId } from '../types'

const QUERY_LIMIT = 10_000
const TIMEOUT_MS = 10_000

const METRICS: MetricDescriptor[] = [
  { key: 'postgres.query', label: 'SQL query result', unit: 'count' },
]

export function validateReadOnlyQuery(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) throw new Error('Postgres query cannot be empty.')
  if (trimmed.length > QUERY_LIMIT) {
    throw new Error(`Postgres query must be ${QUERY_LIMIT.toLocaleString()} characters or fewer.`)
  }
  if (trimmed.includes(';')) {
    throw new Error('Postgres metric must be a single statement without semicolons.')
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Postgres metric must start with SELECT or WITH.')
  }
  return trimmed
}

export function parsePostgresNumber(value: unknown): number {
  const parsed = parseSheetNumber([[value]])
  if (parsed === null) throw new Error('Postgres query did not return a numeric first column.')
  return parsed
}

type PgClient = {
  connect(): Promise<void>
  query(query: string): Promise<QueryResult<Record<string, unknown>>>
  end(): Promise<void>
}

type ResolveConnection = (
  ctx: MetricSourceContext,
) => Promise<{ connectionString: string; caCert?: string }>

async function resolveConnection(
  ctx: MetricSourceContext,
): Promise<{ connectionString: string; caCert?: string }> {
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

function clientConfig(connectionString: string, caCert?: string): ClientConfig {
  const config: ClientConfig = {
    connectionString,
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
    options: '-c default_transaction_read_only=on',
  }
  try {
    const parsed = new URL(connectionString)
    const sslmode = parsed.searchParams.get('sslmode')
    if (sslmode) {
      if (sslmode === 'disable') {
        throw new Error('Postgres metric connections cannot disable TLS verification.')
      }
      parsed.searchParams.delete('sslmode')
      config.connectionString = parsed.toString()
      config.ssl = { rejectUnauthorized: true, ...(caCert ? { ca: caCert } : {}) }
    } else if (caCert) {
      config.ssl = { rejectUnauthorized: true, ca: caCert }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('cannot disable TLS')) throw error
    // Let pg produce the normal invalid-connection-string message. Never copy
    // the secret into our own error text.
  }
  return config
}

function safeError(error: unknown, connectionString: string): Error {
  const raw = error instanceof Error ? error.message : 'Postgres metric query failed.'
  let message = raw
    .split(connectionString)
    .join('[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[redacted]')
  try {
    const parsed = new URL(connectionString)
    for (const secret of [parsed.username, parsed.password]) {
      if (secret) message = message.split(decodeURIComponent(secret)).join('[redacted]')
    }
  } catch {
    // Invalid URLs have no safely-addressable username/password components.
  }
  const tlsHint = /certificate|self.signed|unable to verify|tls|ssl/i.test(message)
    ? ' Supply the issuing CA certificate in the vault credential; TLS verification cannot be disabled.'
    : ''
  return new Error(`${message}${tlsHint}`)
}

export function makePostgresMetricSource(deps?: {
  resolve?: ResolveConnection
  createClient?: (config: ClientConfig) => PgClient
}): MetricSource {
  const resolve = deps?.resolve ?? resolveConnection
  const createClient = deps?.createClient ?? ((config: ClientConfig) => new Client(config))
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
      const { connectionString, caCert } = await resolve(ctx)
      const client = createClient(clientConfig(connectionString, caCert))
      try {
        await client.connect()
        const result = await client.query(query)
        if (result.rows.length === 0) throw new Error('Postgres query returned no rows.')
        const firstRow = result.rows[0]
        const firstValue = firstRow[Object.keys(firstRow)[0]]
        return { value: parsePostgresNumber(firstValue), asOf: new Date() }
      } catch (error) {
        throw safeError(error, connectionString)
      } finally {
        await client.end().catch(() => undefined)
      }
    },
  }
}

export const postgresMetricSource = makePostgresMetricSource()
