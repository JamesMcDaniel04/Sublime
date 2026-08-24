import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope } from '@/lib/server/visibility'
import { goalReadWhere } from '@/lib/server/goal-scope'
import { rateLimit } from '@/lib/ratelimit'
import { createAgentRequest, MAX_REQUEST_TEXT_CHARS, RequestDispatchError } from '@/lib/agents/request-dispatch'

export const runtime = 'nodejs'

const bodySchema = z.object({
  text: z.string().trim().min(1, 'Say what you want the agent to do.').max(MAX_REQUEST_TEXT_CHARS),
  // A cuid, not a uuid — Goal.id is cuid-shaped, matching the work routes.
  goalId: z.string().min(1).max(64).nullable().optional(),
})

/** pathname: /api/agents/<agentId>/requests */
const agentIdFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-2) ?? '')

export const POST = withAuthenticatedApi(async (request, auth) => {
  const agentId = agentIdFrom(request.nextUrl.pathname)
  if (!agentId) throw new ApiError('Agent id is required')

  // Same ceiling as the manual execute route: being authenticated is not a
  // license to mint unbounded runs, and a request mints one per call.
  const limited = await rateLimit(`request:${auth.dbUser.id}`, { limit: 60, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Rate limit exceeded', 429, 'RATE_LIMITED')

  const body = bodySchema.parse(await request.json())

  const agent = await prisma.agentTask.findFirst({
    where: {
      id: agentId,
      organizationId: auth.organizationId,
      status: 'ACTIVE',
      // You can address any agent you can already see. Private agents stay
      // addressable only by their owner.
      ...agentReadScope(auth.dbUser.id),
    },
    select: { id: true, agentType: true, description: true, metadata: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  // A goal association is only honored if the requester can actually read that
  // goal — otherwise filing a request would be a way to attach work to, and
  // later read results from, a restricted goal you are not a member of.
  if (body.goalId) {
    const goal = await prisma.goal.findFirst({
      where: {
        id: body.goalId,
        organizationId: auth.organizationId,
        ...goalReadWhere(auth.dbUser.id, { isAdmin: auth.isAdmin }),
      },
      select: { id: true },
    })
    if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
  }

  let created: { requestId: string; executionId: string }
  try {
    created = await createAgentRequest({
      organizationId: auth.organizationId,
      requestedByUserId: auth.dbUser.id,
      agent,
      text: body.text,
      goalId: body.goalId ?? null,
      origin: 'app',
    })
  } catch (error) {
    if (error instanceof RequestDispatchError) {
      throw new ApiError(error.message, 503, error.code)
    }
    throw error
  }

  return { success: true, ...created, status: 'pending' }
}, { requires: 'member' })
