/**
 * Shared Postgres client construction and error redaction.
 *
 * This is the single hardened entry point to a customer database. It was
 * extracted from the goal-metric source (`src/lib/metrics/sources/postgres.ts`)
 * when Postgres became a first-class integration, so the metric source, the
 * agent/flow tool plane, and the intelligence scan all connect through exactly
 * one implementation rather than three drifting copies.
 *
 * The two invariants that must never be relaxed:
 *
 *  1. The connection string is parsed HERE and reduced to explicit fields — it
 *     is never handed to pg as a string. pg merges string query params over the
 *     explicit config (verified against pg 8.x), so a credential carrying
 *     `?options=-c default_transaction_read_only=off&statement_timeout=0&ssl=0`
 *     would otherwise defeat every hardening layer at once. By constructing the
 *     config ourselves, no query param ever reaches the driver; we honor
 *     exactly one (`sslmode`) with our own semantics, and only to reject
 *     `disable`.
 *  2. Verified TLS is the default for every non-loopback host, with no opt-out
 *     — a private CA goes in the connection's caCert. Loopback connects without
 *     TLS (the bytes never leave the machine), which also keeps local/CI
 *     verification working.
 */
import { Client, type ClientConfig, type QueryResult } from 'pg'

export const TIMEOUT_MS = 10_000

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

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
    throw new Error('Postgres connections cannot disable TLS verification.')
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

/**
 * Non-secret 'host:port/database' label shown in the UI and stored on the row,
 * so listing connections never decrypts a secret. Deliberately drops the user
 * and password components.
 */
export function displayTargetFor(connectionString: string): string {
  const url = new URL(connectionString)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  return `${url.hostname}:${url.port || '5432'}/${database}`
}

/**
 * Strip anything credential-shaped out of a driver error before it reaches a
 * user, a log, or a model. pg happily embeds the host and, on some failures,
 * the whole connection target — none of which should escape this boundary.
 */
export function safeError(error: unknown, connectionString: string): Error {
  const raw = error instanceof Error ? error.message : 'Postgres query failed.'
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
    ? ' Supply the issuing CA certificate on the connection; TLS verification cannot be disabled.'
    : ''
  return new Error(`${message}${tlsHint}`)
}

/**
 * The slice of `pg.Client` this codebase uses — narrowed so tests can fake it.
 *
 * `connect` resolves to `unknown` rather than `void` because pg's own typings
 * resolve it to the Client instance; every caller here awaits it for its
 * effect and ignores the value.
 */
export type PgClient = {
  connect(): Promise<unknown>
  query(query: string, values?: unknown[]): Promise<QueryResult<Record<string, unknown>>>
  end(): Promise<void>
}

export type CreatePgClient = (config: ClientConfig) => PgClient

export const createPgClient: CreatePgClient = (config) => new Client(config)

/**
 * Run `fn` against a connected client inside an explicit READ ONLY transaction
 * with its own statement timeout.
 *
 * Layer 2, in-band and pooler-proof: READ ONLY is enforced by the SERVER
 * per-transaction, which makes it immune both to startup-packet options being
 * dropped by a connection pooler and to connection-string overrides. This is
 * the layer that still holds if the statement denylist is ever outwitted.
 */
export async function withReadOnlyTransaction<T>(
  params: { connectionString: string; caCert?: string; createClient?: CreatePgClient },
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const create = params.createClient ?? createPgClient
  const client = create(buildClientConfig(params.connectionString, params.caCert))
  try {
    await client.connect()
    await client.query('BEGIN TRANSACTION READ ONLY')
    await client.query(`SET LOCAL statement_timeout = '${TIMEOUT_MS}ms'`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    throw safeError(error, params.connectionString)
  } finally {
    await client.end().catch(() => undefined)
  }
}

/**
 * Run a data-modifying statement inside a normal transaction.
 *
 * Deliberately separate from `withReadOnlyTransaction` so no caller can reach
 * a writable session by passing a flag — reaching this function is an explicit
 * decision, and every caller of it must have already checked the connection's
 * `allowWrites` column and passed the statement through `validateWriteStatement`.
 */
export async function withWriteTransaction<T>(
  params: { connectionString: string; caCert?: string; createClient?: CreatePgClient },
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const create = params.createClient ?? createPgClient
  const client = create(buildClientConfig(params.connectionString, params.caCert))
  try {
    await client.connect()
    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = '${TIMEOUT_MS}ms'`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw safeError(error, params.connectionString)
  } finally {
    await client.end().catch(() => undefined)
  }
}
