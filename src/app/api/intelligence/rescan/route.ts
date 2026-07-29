import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { scanConnection } from '@/lib/intelligence/connection-scan'
import { DELIVERY_PROVIDERS, type DeliveryCapability } from '@/lib/nango/delivery'

export const runtime = 'nodejs'
// Runs the scan inline (not `after`) so the manual "Rescan" action can show
// its result — the LLM distillation pass can take a while, so give it room.
export const maxDuration = 300

const bodySchema = z.object({
  plane: z.enum(['nango', 'mcp']),
  connectionRef: z.string().min(1),
  connectionName: z.string().min(1),
})

/** Verify the caller's org actually owns the referenced connection before scanning it. */
async function assertOwnedConnection(
  organizationId: string,
  userId: string,
  plane: 'nango' | 'mcp',
  connectionRef: string,
): Promise<void> {
  if (plane === 'mcp') {
    const connection = await prisma.mcpConnection.findFirst({
      where: { id: connectionRef, organizationId, OR: [{ userId }, { userId: null, provider: { not: null } }] },
      select: { id: true },
    })
    if (!connection) throw new ApiError('Connection not found', 404, 'NOT_FOUND')
    return
  }
  // plane === 'nango': connectionRef is a delivery capability (slack|gmail|salesforce),
  // not a row id — verify the org has a matching connected row.
  const keys = DELIVERY_PROVIDERS[connectionRef as DeliveryCapability] as readonly string[] | undefined
  if (!keys) throw new ApiError('Unknown connection', 404, 'NOT_FOUND')
  const connection = await prisma.nangoConnection.findFirst({
    where: { organizationId, providerConfigKey: { in: [...keys] } },
    select: { id: true },
  })
  if (!connection) throw new ApiError('Connection not found', 404, 'NOT_FOUND')
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { plane, connectionRef, connectionName } = bodySchema.parse(await request.json())
  await assertOwnedConnection(auth.organizationId, auth.dbUser.id, plane, connectionRef)

  const result = await scanConnection({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    plane,
    connectionRef,
    connectionName,
  })

  return { success: true, result }
}, { requires: 'member' })
