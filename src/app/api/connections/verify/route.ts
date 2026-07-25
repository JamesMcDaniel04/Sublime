import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { recordVerification } from '@/lib/connections/record-verification'
import { toVerification } from '@/lib/connections/verification'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

/**
 * POST /api/connections/verify — re-check one connection on demand.
 *
 * Verification is otherwise earned passively (an explicit test, the OAuth
 * callback, or a real run). This is the "check it now" button for a connection
 * showing stale or unverified.
 *
 * A generic vault credential cannot be probed without a target — there is no
 * endpoint to call — so this route refuses rather than inventing a check and
 * reporting a pass nobody earned.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  // Discovery makes outbound requests to caller-named connections; cap it.
  const limited = await rateLimit(`verify-connection:${auth.dbUser.id}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many checks — slow down.', 429, 'RATE_LIMITED')

  const { connectionId } = z
    .object({ connectionId: z.string().min(1) })
    .parse(await request.json().catch(() => ({})))

  if (connectionId.startsWith('credential:')) {
    throw new ApiError(
      'A saved credential has no endpoint to test on its own. Attach it to a step and test that step instead.',
      400,
      'CREDENTIAL_NOT_PROBEABLE',
    )
  }

  // Discovery IS the check: loadFlowToolCatalog reaches the connection and
  // reports toolsError when the credential doesn't work.
  const catalog = await loadFlowToolCatalog(auth.organizationId, {
    userId: auth.dbUser.id,
    connectionIds: [connectionId],
  })
  const entry = catalog.find((candidate) => candidate.id === connectionId)
  if (!entry) throw new ApiError('Connection not found', 404, 'NOT_FOUND')

  const ok = !entry.toolsError && entry.tools.length > 0
  await recordVerification({
    organizationId: auth.organizationId,
    connectionId,
    state: ok ? 'verified' : 'failed',
    error: ok ? null : entry.toolsError ?? 'This connection reported no actions.',
  })
  const row = await prisma.connectionVerification.findFirst({
    where: { organizationId: auth.organizationId, connectionId },
    select: { state: true, checkedAt: true, error: true },
  })
  return { success: true, verification: toVerification(row), toolCount: entry.tools.length }
})
