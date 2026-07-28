/**
 * PostgresConnection persistence: encrypt on the way in, redact on the way
 * out, decrypt only to open a connection.
 *
 * SECRETS DISCIPLINE (same rule as the credential vault): the result of
 * `resolvePostgresConnection` is transient. It exists to open one connection
 * and must never reach a run row, a graph, a log line, or a client response.
 */
import { prisma } from '@/lib/prisma'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import { displayTargetFor } from './client'

/** What a list/detail API response may carry — no secret, in any form. */
export type RedactedPostgresConnection = {
  id: string
  name: string
  /** 'host:5432/dbname' — never the user or password. */
  displayTarget: string
  hasCaCert: boolean
  allowWrites: boolean
  defaultSchema: string
  status: string
  lastError: string | null
  lastUsedAt: string | null
  createdAt: string
}

export type PostgresConnectionInput = {
  name: string
  /** Blank on edit means "keep the stored one" — same rule as the credential editor. */
  connectionString?: string
  caCert?: string
  allowWrites?: boolean
  defaultSchema?: string
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export function redactPostgresConnection(row: {
  id: string
  name: string
  displayTarget: string
  authConfig: unknown
  allowWrites: boolean
  defaultSchema: string
  status: string
  lastError: string | null
  lastUsedAt: Date | null
  createdAt: Date
}): RedactedPostgresConnection {
  return {
    id: row.id,
    name: row.name,
    displayTarget: row.displayTarget,
    hasCaCert: Boolean(asRecord(row.authConfig).caCert),
    allowWrites: row.allowWrites,
    defaultSchema: row.defaultSchema,
    status: row.status,
    lastError: row.lastError,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Build the stored authConfig for a create/update.
 *
 * An omitted `connectionString` on update keeps the stored ciphertext; an
 * omitted `caCert` likewise. An explicitly EMPTY caCert clears it, which is how
 * a user removes a private CA after moving to a publicly-trusted certificate.
 */
export function buildPostgresAuthConfig(
  input: { connectionString?: string; caCert?: string },
  existing: unknown = {},
): Record<string, unknown> {
  const stored = asRecord(existing)
  const next: Record<string, unknown> = { ...stored }
  if (input.connectionString) next.connectionString = encryptSecret(input.connectionString)
  if (input.caCert !== undefined) {
    if (input.caCert.trim()) next.caCert = encryptSecret(input.caCert)
    else delete next.caCert
  }
  return next
}

export type ResolvedPostgresConnection = {
  id: string
  name: string
  connectionString: string
  caCert?: string
  allowWrites: boolean
  defaultSchema: string
}

export function decryptPostgresAuthConfig(authConfig: unknown): { connectionString: string; caCert?: string } {
  const stored = asRecord(authConfig)
  const connectionString = typeof stored.connectionString === 'string' ? decryptSecret(stored.connectionString) : ''
  if (!connectionString) {
    throw new Error('This Postgres connection has no stored connection string — edit it and re-enter one.')
  }
  const caCert = typeof stored.caCert === 'string' ? decryptSecret(stored.caCert) : undefined
  return { connectionString, ...(caCert ? { caCert } : {}) }
}

/** Load + decrypt one connection, scoped to the organization. */
export async function resolvePostgresConnection(
  organizationId: string,
  connectionId: string,
): Promise<ResolvedPostgresConnection> {
  const row = await prisma.postgresConnection.findFirst({
    where: { id: connectionId, organizationId },
    select: { id: true, name: true, authConfig: true, allowWrites: true, defaultSchema: true },
  })
  if (!row) {
    throw new Error('That Postgres connection is unavailable — check Integrations → PostgreSQL.')
  }
  return {
    id: row.id,
    name: row.name,
    ...decryptPostgresAuthConfig(row.authConfig),
    allowWrites: row.allowWrites,
    defaultSchema: row.defaultSchema,
  }
}

/** Derive the stored non-secret display label. Throws on an unparseable URL. */
export { displayTargetFor }
