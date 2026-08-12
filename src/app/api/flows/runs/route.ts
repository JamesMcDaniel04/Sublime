import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { workspaceFlowRunScope } from '@/lib/server/visibility'
import { deriveRunWaiting } from '@/lib/flows/run-waiting'

// GET /api/flows/runs — workspace-wide run history, across every flow.
//
// Run history existed only per-flow (/api/flows/[id]/runs), so "what ran, and
// what broke, anywhere in my workspace" had no answer short of opening each
// flow in turn. This is the cross-flow execution log; the per-flow route is
// unchanged and still what the builder polls.
//
// Visibility is deliberately NOT widened along with the scope: a run is yours
// to see only if you started it, because its input/output can carry your data.
// See workspaceFlowRunScope.
//
// Query params (all optional):
//   status=a,b        comma-separated run statuses
//   flowId=x          narrow to one flow (same shape, no separate endpoint)
//   take=N            page size, default 20, capped at 100
//   cursor=<runId>    keyset page: returns runs strictly older than this one
//   includeNodeTests=1  include builder single-node tests (excluded by default)
export const GET = withAuthenticatedApi(async (request, auth) => {
  const searchParams = request.nextUrl.searchParams
  const statusList = (searchParams.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const flowId = searchParams.get('flowId')?.trim() || null
  const takeParam = Number(searchParams.get('take'))
  const take = Number.isFinite(takeParam) && takeParam > 0 ? Math.min(100, Math.floor(takeParam)) : 20
  const includeNodeTests = searchParams.get('includeNodeTests') === '1'
  const cursor = searchParams.get('cursor')?.trim() || null

  // Keyset rather than offset: this list is polled while runs are being
  // created, and an offset page silently repeats or skips rows as the head
  // shifts underneath it. Resolving the cursor's startedAt inside the org scope
  // keeps a guessed id from probing another tenant's rows.
  let before: Date | null = null
  if (cursor) {
    const anchor = await prisma.flowRun.findFirst({
      where: { id: cursor, organizationId: auth.organizationId },
      select: { startedAt: true },
    })
    // An unknown cursor returns the first page rather than erroring — the row
    // may simply have aged out of retention between two polls.
    before = anchor?.startedAt ?? null
  }

  const runs = await prisma.flowRun.findMany({
    where: {
      organizationId: auth.organizationId,
      ...workspaceFlowRunScope(auth.dbUser.id),
      ...(flowId ? { flowId } : {}),
      ...(statusList.length ? { status: { in: statusList } } : {}),
      ...(includeNodeTests ? {} : { NOT: { trigger: { path: ['type'], equals: 'node_test' } } }),
      ...(before ? { startedAt: { lt: before } } : {}),
    },
    // Ties broken by id so a keyset page is stable when two runs share a
    // startedAt — without it, rows can repeat or vanish across pages.
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take,
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      trigger: true,
      error: true,
      // Named here so the list can group by flow without a second round trip.
      flow: { select: { id: true, name: true } },
      steps: {
        orderBy: { order: 'asc' },
        // Same tail-safe cap as the per-flow route: a loop-heavy run
        // accumulates steps without limit and this endpoint is polled.
        take: 500,
        // Summary shape only — a workspace-wide list has no business shipping
        // every run's full input/output. Open the flow for that.
        select: { nodeId: true, status: true, order: true, error: true, output: true },
      },
    },
  })

  return {
    success: true,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      trigger: run.trigger,
      error: run.error,
      flowId: run.flow.id,
      flowName: run.flow.name,
      waiting: deriveRunWaiting(run.status, run.steps),
      steps: run.steps.map(({ nodeId, status, order, error }) => ({ nodeId, status, order, error })),
    })),
    // Null when this page did not fill, which is how a caller knows to stop.
    nextCursor: runs.length === take ? runs[runs.length - 1]!.id : null,
  }
}, { requires: 'member' })
