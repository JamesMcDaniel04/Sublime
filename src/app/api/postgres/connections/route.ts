import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { assertIntegrationCapacity } from '@/lib/billing/enforce'
import { afterResponse } from '@/lib/server/after-response'
import { recordAudit } from '@/lib/audit'
import {
  buildPostgresAuthConfig,
  redactPostgresConnection,
  displayTargetFor,
} from '@/lib/postgres/connections'
import { buildClientConfig } from '@/lib/postgres/client'
import { scanConnection } from '@/lib/intelligence/connection-scan'
import { verifyPostgresConnection } from '@/lib/postgres/verify'

export const runtime = 'nodejs'

// GET/POST /api/postgres/connections — natively connected customer databases.
//
// Reads are ALWAYS redacted: a connection string enters through POST/PATCH and
// leaves only through the server-side resolver at query time. No route ever
// returns it, and the stored `displayTarget` exists so listing never needs to
// decrypt anything at all.

const LIST_SELECT = {
  id: true,
  name: true,
  displayTarget: true,
  authConfig: true,
  allowWrites: true,
  defaultSchema: true,
  status: true,
  lastError: true,
  lastUsedAt: true,
  createdAt: true,
} as const

const createSchema = z.object({
  name: z.string().min(1, 'Give this database a name.').max(80),
  connectionString: z.string().min(1, 'Enter a postgres:// connection string.'),
  caCert: z.string().max(100_000).optional(),
  allowWrites: z.boolean().optional(),
  defaultSchema: z.string().max(63).optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const rows = await prisma.postgresConnection.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { name: 'asc' },
    select: LIST_SELECT,
  })
  return { success: true, connections: rows.map(redactPostgresConnection) }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = createSchema.parse(await request.json().catch(() => ({})))

  // Validate the connection string BEFORE storing it: buildClientConfig is the
  // same parser the runtime uses, so a string it rejects could never be used.
  // This also produces the non-secret display target.
  buildClientConfig(input.connectionString, input.caCert)
  const displayTarget = displayTargetFor(input.connectionString)

  const clash = await prisma.postgresConnection.findFirst({
    where: { organizationId: auth.organizationId, name: input.name },
    select: { id: true },
  })
  if (clash) throw new ApiError('A database with that name already exists.', 409, 'DUPLICATE_NAME')

  // Databases mirror into nango_connections and count as integrations — same
  // gate as the Nango/MCP creation entrypoints.
  await assertIntegrationCapacity(auth.organizationId)

  const row = await prisma.postgresConnection.create({
    data: {
      organizationId: auth.organizationId,
      name: input.name,
      authConfig: buildPostgresAuthConfig(input),
      displayTarget,
      allowWrites: input.allowWrites ?? false,
      defaultSchema: input.defaultSchema?.trim() || 'public',
      createdById: auth.dbUser.id,
    },
    select: LIST_SELECT,
  })

  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'postgres.connection.create',
    resourceType: 'postgres_connection',
    resourceId: row.id,
    // Name, target, and write policy only — never the connection string.
    detail: { name: row.name, displayTarget, allowWrites: row.allowWrites },
  })

  // Save-then-test: the row exists even when the database is unreachable (a
  // VPN allowlist that has not been updated yet), and the failure is visible
  // on the row rather than blocking the save.
  const verification = await verifyPostgresConnection(auth.organizationId, row.id)

  // Scan on connect, mirroring the Nango path. Fire-and-forget: the connection
  // is already saved, so nothing here may fail the response.
  if (verification.ok) {
    const organizationId = auth.organizationId
    afterResponse(() =>
      scanConnection({
        organizationId,
        userId: auth.dbUser.id,
        plane: 'postgres',
        connectionRef: row.id,
        connectionName: row.name,
      }),
    )
  }

  return {
    success: true,
    connection: { ...redactPostgresConnection(row), status: verification.status, lastError: verification.error ?? null },
  }
}, { requires: 'settings:workspace' })
