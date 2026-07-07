import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { hashToken } from '@/lib/crypto/secrets'

// Mint (or rotate) the flow's webhook trigger secret. Mirrors the agent
// trigger-secret: only a SHA-256 hash is stored (inside flow.trigger), so the
// plaintext is returned exactly once at mint/rotate time.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { rotate } = z.object({ rotate: z.boolean().default(false) }).parse(await request.json().catch(() => ({})))

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const trigger = (flow.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
  const hasSecret = typeof trigger.webhookSecretHash === 'string'
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  const base = {
    success: true as const,
    url: `${baseUrl}/api/flows/${flow.id}/trigger`,
    usage: 'POST with header "x-trigger-secret: <secret>" and optional JSON body {"input": "..."}',
  }

  if (hasSecret && !rotate) return { ...base, hasSecret: true, secret: null }

  const secret = randomBytes(24).toString('base64url')
  await prisma.flow.update({
    where: { id: flow.id },
    data: { trigger: { ...trigger, webhookSecretHash: hashToken(secret) } },
  })
  return { ...base, hasSecret: true, secret }
})
