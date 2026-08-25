import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withPublicApi } from '@/lib/server/public-api-handler'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'

const bodySchema = z.object({
  input: z.unknown().optional(),
  /** Caller-supplied key making a retried POST safe. */
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  /** Wait for the result instead of returning a queued run id. */
  wait: z.boolean().default(false),
})

/**
 * POST /api/v1/flows/{id}/run — run a flow.
 *
 * Requires `flows:execute`, which `flows:write` does NOT imply: editing a flow
 * and firing it at production systems are different powers, and a key issued
 * to keep definitions in sync should not be able to invoke them.
 *
 * Only PUBLISHED flows run. A machine caller cannot see the builder, so
 * running an unreviewed draft would let an unfinished edit reach production
 * with nobody watching — the same rule the form trigger and webhook enforce.
 */
export const POST = withPublicApi(async (request, context, params) => {
  const raw = await request.json().catch(() => ({}))
  const body = bodySchema.parse(raw)

  const flow = await prisma.flow.findFirst({
    where: { id: params.id, organizationId: context.organizationId },
    select: { id: true, status: true, publishedGraph: true },
  })
  if (!flow) throw Object.assign(new Error('Flow not found.'), { statusCode: 404, code: 'NOT_FOUND' })
  if (!flow.publishedGraph) {
    throw Object.assign(new Error('This flow has not been published.'), { statusCode: 409, code: 'NOT_PUBLISHED' })
  }
  if (flow.status === 'DISABLED') {
    throw Object.assign(new Error('This flow is disabled.'), { statusCode: 409, code: 'DISABLED' })
  }

  const result = await dispatchFlowExecution({
    flowId: flow.id,
    organizationId: context.organizationId,
    userId: context.actingUserId,
    input: body.input ?? null,
    trigger: { type: 'api', apiKeyId: context.apiKeyId },
    ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
  } as never, { background: !body.wait })

  if ('queued' in result) {
    return { success: true, runId: result.flowRunId, status: 'queued' }
  }
  return {
    success: true,
    runId: result.flowRunId,
    status: result.status,
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
  }
}, { scope: 'flows:execute', perMinute: 30 })
