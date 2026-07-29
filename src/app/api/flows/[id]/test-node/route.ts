import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { flowReadScope } from '@/lib/server/visibility'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'
import { flowGraphSchema } from '@/lib/flows/graph'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/flows/[id]/test-node — run exactly ONE node of the draft graph.
 *
 * Separate from /execute deliberately: this must not record a manual-run
 * behaviour event, and its FlowRun is tagged `node_test` so builder
 * experiments don't pollute run history. Downstream nodes never execute (see
 * interpret.ts `onlyNodeId`), so testing a step can't fire a later write.
 * Awaited, not backgrounded — the NDV shows this node's output inline, so the
 * caller wants the result rather than a run id to poll.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  // This route executes arbitrary user-authored JavaScript/Python (the Code
  // step) and arbitrary outbound HTTP, so an unthrottled caller can saturate
  // a worker. Generous enough for real builder use — testing a step is an
  // interactive, one-at-a-time action — while bounding a hot loop.
  const limited = await rateLimit(`test-node:${auth.dbUser.id}`, { limit: 40, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many step tests — wait a moment and try again.', 429, 'RATE_LIMITED')
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  // Visibility gate mirrors /execute: a private flow may only be run by its owner.
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { id: true, graph: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const parsed = z
    .object({
      nodeId: z.string().min(1),
      input: z.unknown().optional(),
      mockOutputs: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await request.json().catch(() => ({})))

  // Containers are refused up front with the canonical message (the
  // interpreter guards this too, defence-in-depth) — their behaviour IS
  // running their body, so isolating one is meaningless.
  const graph = flowGraphSchema.safeParse(flow.graph)
  const target = graph.success ? graph.data.nodes.find((node) => node.id === parsed.nodeId) : undefined
  if (!target) throw new ApiError('That step is no longer part of this flow — reopen it and try again.', 400, 'NODE_NOT_FOUND')
  if (target.type === 'loop' || target.type === 'parallel' || target.type === 'repeatUntil' || target.type === 'errorShield') {
    throw new ApiError('This step contains other steps — test the steps inside it individually.', 400, 'NODE_IS_CONTAINER')
  }

  const result = await dispatchFlowExecution({
    flowId: id,
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    input: parseFlowInput(parsed.input),
    onlyNodeId: parsed.nodeId,
    mockOutputs: parsed.mockOutputs,
    trigger: { type: 'node_test', nodeId: parsed.nodeId },
  })
  const run = 'queued' in result ? { flowRunId: result.flowRunId, status: 'queued', output: null } : result
  return { success: true, run }
}, { requires: 'member' })
