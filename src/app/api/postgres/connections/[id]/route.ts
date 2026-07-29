import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { afterResponse } from '@/lib/server/after-response'
import { recordAudit } from '@/lib/audit'
import { buildPostgresAuthConfig, redactPostgresConnection, displayTargetFor } from '@/lib/postgres/connections'
import { buildClientConfig } from '@/lib/postgres/client'
import { deletePostgresMirror, verifyPostgresConnection } from '@/lib/postgres/verify'
import { purgeConnectionLearnings } from '@/lib/intelligence/connection-scan'

export const runtime = 'nodejs'

// Dynamic segment read from the path, matching the credentials routes — the
// authenticated handler wrapper takes (request, auth) only.
const idFrom = (pathname: string) => pathname.split('/').filter(Boolean).at(-1) ?? ''

const SELECT = {
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

// A blank/absent connectionString means "keep the stored one" — the same rule
// the credential editor uses, so an edit never round-trips a secret through
// the browser just to change a name or toggle writes.
const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  connectionString: z.string().optional(),
  caCert: z.string().max(100_000).optional(),
  allowWrites: z.boolean().optional(),
  defaultSchema: z.string().max(63).optional(),
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const input = patchSchema.parse(await request.json().catch(() => ({})))

  const existing = await prisma.postgresConnection.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, name: true, authConfig: true, allowWrites: true },
  })
  if (!existing) throw new ApiError('That database connection no longer exists.', 404, 'NOT_FOUND')

  if (input.name && input.name !== existing.name) {
    const clash = await prisma.postgresConnection.findFirst({
      where: { organizationId: auth.organizationId, name: input.name, id: { not: id } },
      select: { id: true },
    })
    if (clash) throw new ApiError('A database with that name already exists.', 409, 'DUPLICATE_NAME')
  }

  // Only re-derive the display target when a new connection string arrives —
  // validating it first, so a bad string is rejected before it is stored.
  let displayTarget: string | undefined
  if (input.connectionString) {
    buildClientConfig(input.connectionString, input.caCert)
    displayTarget = displayTargetFor(input.connectionString)
  }

  // updateMany, not update: the tenant guard requires organizationId in the
  // where clause, and `update` takes only a unique selector. Scoping the write
  // itself — not just the preceding read — is the invariant.
  await prisma.postgresConnection.updateMany({
    where: { id: existing.id, organizationId: auth.organizationId },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(displayTarget ? { displayTarget } : {}),
      ...(input.allowWrites !== undefined ? { allowWrites: input.allowWrites } : {}),
      ...(input.defaultSchema !== undefined ? { defaultSchema: input.defaultSchema.trim() || 'public' } : {}),
      ...(input.connectionString || input.caCert !== undefined
        ? { authConfig: buildPostgresAuthConfig(input, existing.authConfig) }
        : {}),
    },
  })
  const row = await prisma.postgresConnection.findFirstOrThrow({
    where: { id: existing.id, organizationId: auth.organizationId },
    select: SELECT,
  })

  // Enabling writes is the consequential change here, so it is audited as its
  // own event rather than folded into a generic update.
  if (input.allowWrites !== undefined && input.allowWrites !== existing.allowWrites) {
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: input.allowWrites ? 'postgres.writes.enable' : 'postgres.writes.disable',
      resourceType: 'postgres_connection',
      resourceId: row.id,
      detail: { name: row.name },
    })
  }

  // A new connection string invalidates the previous proof — re-verify so the
  // grid never shows a green badge earned by credentials that no longer exist.
  const verification = input.connectionString
    ? await verifyPostgresConnection(auth.organizationId, row.id)
    : null

  return {
    success: true,
    connection: verification
      ? { ...redactPostgresConnection(row), status: verification.status, lastError: verification.error ?? null }
      : redactPostgresConnection(row),
  }
}, { requires: 'settings:workspace' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)

  const existing = await prisma.postgresConnection.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, name: true },
  })
  if (!existing) throw new ApiError('That database connection no longer exists.', 404, 'NOT_FOUND')

  await prisma.postgresConnection.deleteMany({ where: { id: existing.id, organizationId: auth.organizationId } })
  await deletePostgresMirror(auth.organizationId, existing.id)

  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'postgres.connection.delete',
    resourceType: 'postgres_connection',
    resourceId: existing.id,
    detail: { name: existing.name },
  })

  // Disconnecting must also drop what the scan learned from this database —
  // the same purge-on-disconnect rule Nango connections follow. The row is
  // already gone, so a purge failure must not fail the response.
  const organizationId = auth.organizationId
  afterResponse(() => purgeConnectionLearnings({ organizationId, plane: 'postgres', connectionRef: existing.id }))

  return { success: true }
}, { requires: 'settings:workspace' })
