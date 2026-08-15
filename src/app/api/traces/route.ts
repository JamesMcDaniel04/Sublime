import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope, workspaceFlowRunScope } from '@/lib/server/visibility'
import { costRateFor } from '@/lib/goals/impact'
import { normalizeAgentStatus, normalizeFlowStatus, costUsdOf, type TraceStatus } from '@/lib/traces/envelope'
import { decodeCursor, encodeCursor, mergeTracePages } from '@/lib/traces/merge'

export const runtime = 'nodejs'

const PAGE = 25

/** Normalized → source statuses, per store. Unknown filter values match nothing. */
const AGENT_STATUSES: Record<TraceStatus, string[]> = {
  queued: ['pending'],
  running: ['running'],
  waiting: ['waiting_for_input'],
  succeeded: ['completed'],
  failed: ['failed'],
  stopped: ['cancelled', 'cancelling'],
}
const FLOW_STATUSES: Record<TraceStatus, string[]> = {
  queued: ['queued', 'claimed'],
  running: ['running'],
  waiting: ['waiting'],
  succeeded: ['succeeded'],
  failed: ['failed'],
  stopped: ['stopping', 'stopped'],
}

/** Agent display name: metadata title, else first description line, else type. */
const agentNameOf = (execution: {
  agentType: string
  agentTask: { description: string; metadata: unknown } | null
}): string =>
  (execution.agentTask?.metadata as { title?: string } | null)?.title ||
  execution.agentTask?.description.split('\n')[0] ||
  execution.agentType

// GET /api/traces — the unified run stream over both run stores. Projection
// only: visibility is exactly the stores' own rules (your runs; ownerless runs
// of flows you own), so this surface can never show more than the panes it
// unifies. Per-source keyset cursor — see lib/traces/merge.ts.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const searchParams = request.nextUrl.searchParams
  const kind = searchParams.get('kind') // 'agent' | 'flow' | null = both
  const status = searchParams.get('status') as TraceStatus | null
  const q = searchParams.get('q')?.trim() || null
  const cursor = decodeCursor(searchParams.get('cursor'))
  // Time range: invalid dates are ignored (filter chips only send valid ISO).
  const parseDate = (value: string | null) => {
    const date = value ? new Date(value) : null
    return date && !Number.isNaN(date.getTime()) ? date : null
  }
  const from = parseDate(searchParams.get('from'))
  const to = parseDate(searchParams.get('to'))
  const startedAtRange =
    from || to ? { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}

  const wantAgents = kind !== 'flow'
  const wantFlows = kind !== 'agent'

  const [rate, executions, flowRuns] = await Promise.all([
    costRateFor(auth.organizationId),
    wantAgents
      ? prisma.agentExecution.findMany({
          where: {
            organizationId: auth.organizationId,
            ...executionVisibilityScope(auth.dbUser.id),
            ...startedAtRange,
            ...(status ? { status: { in: AGENT_STATUSES[status] ?? [] } } : {}),
            ...(q ? { agentTask: { description: { contains: q, mode: 'insensitive' } } } : {}),
            ...(cursor?.a
              ? {
                  OR: [
                    { startedAt: { lt: new Date(cursor.a[0]) } },
                    { startedAt: new Date(cursor.a[0]), id: { lt: cursor.a[1] } },
                  ],
                }
              : {}),
          },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: PAGE,
          select: {
            id: true,
            status: true,
            startedAt: true,
            completedAt: true,
            inputTokens: true,
            outputTokens: true,
            error: true,
            trigger: true,
            agentType: true,
            agentTaskId: true,
            agentTask: { select: { description: true, metadata: true } },
            _count: { select: { workflowSteps: true } },
          },
        })
      : [],
    wantFlows
      ? prisma.flowRun.findMany({
          where: {
            organizationId: auth.organizationId,
            // workspaceFlowRunScope is an OR and the cursor adds another —
            // AND-wrap the cursor clause so the two OR keys don't collide.
            ...workspaceFlowRunScope(auth.dbUser.id),
            ...startedAtRange,
            NOT: { trigger: { path: ['type'], equals: 'node_test' } },
            ...(status ? { status: { in: FLOW_STATUSES[status] ?? [] } } : {}),
            ...(q ? { flow: { name: { contains: q, mode: 'insensitive' } } } : {}),
            ...(cursor?.f
              ? {
                  AND: [
                    {
                      OR: [
                        { startedAt: { lt: new Date(cursor.f[0]) } },
                        { startedAt: new Date(cursor.f[0]), id: { lt: cursor.f[1] } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: PAGE,
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            error: true,
            trigger: true,
            flowId: true,
            flow: { select: { name: true } },
            _count: { select: { steps: true } },
          },
        })
      : [],
  ])

  const agentRows = executions.map((execution) => ({
    kind: 'agent' as const,
    id: execution.id,
    name: agentNameOf(execution),
    status: normalizeAgentStatus(execution.status, execution.completedAt),
    startedAt: execution.startedAt.toISOString(),
    finishedAt: execution.completedAt?.toISOString() ?? null,
    durationMs: execution.completedAt
      ? execution.completedAt.getTime() - execution.startedAt.getTime()
      : null,
    tokens: { input: execution.inputTokens, output: execution.outputTokens },
    costUsd: costUsdOf(execution.inputTokens, execution.outputTokens, rate),
    toolCallCount: execution._count.workflowSteps,
    // List rows skip the events read; the detail view reports retrieval.
    hasRetrieval: false,
    trigger: (execution.trigger as { type?: string } | null)?.type ?? null,
    error: execution.error,
    resource: { agentTaskId: execution.agentTaskId },
  }))
  const flowRows = flowRuns.map((run) => ({
    kind: 'flow' as const,
    id: run.id,
    name: run.flow.name,
    status: normalizeFlowStatus(run.status, run.finishedAt),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    // Child agent executions are not loaded in lists (N+1) — detail only.
    tokens: null,
    costUsd: null,
    toolCallCount: run._count.steps,
    hasRetrieval: false,
    trigger: (run.trigger as { type?: string } | null)?.type ?? null,
    error: run.error,
    resource: { flowId: run.flowId },
  }))

  const { rows, next } = mergeTracePages<(typeof agentRows)[number] | (typeof flowRows)[number]>(
    agentRows,
    flowRows,
    PAGE,
  )
  // A source the merge never consumed this page keeps its incoming mark —
  // otherwise the next page would restart that source from the top.
  const nextCursor = next
    ? encodeCursor({ a: next.a ?? cursor?.a ?? null, f: next.f ?? cursor?.f ?? null })
    : null
  return { success: true, traces: rows, cursor: nextCursor }
}, { requires: 'member' })
