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

/**
 * Layer 1: statement shape. Single statement, SELECT/WITH only, and a
 * word-boundary denylist so a data-modifying CTE (`WITH x AS (UPDATE …)
 * SELECT …`) or a SELECT-shaped side effect (nextval, advisory locks,
 * dblink) cannot ride in under a SELECT prefix. Column names like
 * `updated_at` do not trip the boundary match; a column literally named
 * `delete` is a false positive we accept — the error says why.
 */
const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|call|do|set|reset|lock|listen|notify|unlisten|refresh|reindex|cluster|comment|security|nextval|setval|lo_import|lo_export|dblink|dblink_exec|pg_advisory_lock|pg_advisory_xact_lock|pg_terminate_backend|pg_cancel_backend|pg_read_file|pg_write_file|pg_ls_dir)\b/i

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
  const forbidden = trimmed.match(FORBIDDEN_KEYWORDS)
  if (forbidden) {
    throw new Error(
      `Postgres metric queries are read-only — '${forbidden[0].toUpperCase()}' is not allowed.`,
    )
  }
  return trimmed
}

export function parsePostgresNumber(value: unknown): number {
  const parsed = parseSheetNumber([[value]])
  if (parsed === null) throw new Error('Postgres query did not return a numeric first column.')
  return parsed
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Layer 0: the connection string is parsed HERE and reduced to explicit
 * fields — it is never handed to pg. pg merges string query params over the
 * explicit config (verified against pg 8.x), so a credential carrying
 * `?options=-c default_transaction_read_only=off&statement_timeout=0&ssl=0`
 * would otherwise defeat every hardening layer at once. By constructing the
 * config ourselves, no query param ever reaches the driver; we honor exactly
 * one (`sslmode`) with our own semantics, and only to reject `disable`.
 *
 * TLS: verified TLS is the default for every non-loopback host — there is no
 * opt-out; a private CA goes in the credential's caCert. Loopback connects
 * without TLS (the bytes never leave the machine), which also keeps local/CI
 * verification working.
 */
export function buildClientConfig(connectionString: string, caCert?: string): ClientConfig {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('Postgres connection string is not a valid postgres:// URL.')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Postgres connection string must use the postgres:// scheme.')
  }
  if (url.searchParams.get('sslmode') === 'disable') {
    throw new Error('Postgres metric connections cannot disable TLS verification.')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!url.hostname || !database) {
    throw new Error('Postgres connection string must include a host and database name.')
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    database,
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
    ...(loopback ? {} : { ssl: { rejectUnauthorized: true, ...(caCert ? { ca: caCert } : {}) } }),
  }
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
      const client = createClient(buildClientConfig(connectionString, caCert))
      try {
        await client.connect()
        // Layer 2, in-band and pooler-proof: the user query runs inside an
        // explicit READ ONLY transaction with its own statement timeout —
        // enforced by the server per-transaction, immune to startup-packet
        // drops and connection-string overrides alike.
        await client.query('BEGIN TRANSACTION READ ONLY')
        await client.query(`SET LOCAL statement_timeout = '${TIMEOUT_MS}ms'`)
        const result = await client.query(query)
        await client.query('COMMIT')
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
