import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { afterResponse } from '@/lib/server/after-response'
import { verifyPostgresConnection } from '@/lib/postgres/verify'
import { scanConnection } from '@/lib/intelligence/connection-scan'

export const runtime = 'nodejs'

/**
 * POST /api/postgres/connections/:id/test — prove the connection works.
 *
 * Split from create/update on purpose: a database behind a VPN or IP allowlist
 * can be saved before it is reachable, and the user tests it once the network
 * path exists. Any member may test (it is a read of state they can already
 * see); only an admin can change the connection.
 */
// `/api/postgres/connections/<id>/test` — the id is the segment before 'test'.
const idFrom = (pathname: string) => pathname.split('/').filter(Boolean).at(-2) ?? ''

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const row = await prisma.postgresConnection.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, name: true },
  })
  if (!row) throw new ApiError('That database connection no longer exists.', 404, 'NOT_FOUND')

  const verification = await verifyPostgresConnection(auth.organizationId, row.id)

  // A connection that only now became reachable has never been scanned, so a
  // successful test is also a connect event.
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

  return { success: true, status: verification.status, error: verification.error ?? null }
})
