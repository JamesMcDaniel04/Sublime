/**
 * Stuck flow-run recovery. Flows execute inline in serverless/dispatcher
 * processes (no BullMQ job wraps them yet), so a recycled process orphans the
 * FlowRun as `running` forever — and the scheduled-flow overlap guard then
 * skips every future tick for that flow. The cron dispatch tick calls
 * reapStuckFlowRuns() to fail anything running past the budget, mirroring the
 * agent-execution reaper.
 */

import { systemPrisma } from '@/lib/prisma'

// Dispatch/execute routes cap at maxDuration 1200s; 30 min = budget + slack.
export const STUCK_FLOW_RUN_TIMEOUT_MS = 30 * 60 * 1000

const STUCK_RUN_ERROR = 'The run was interrupted and timed out.'
const REAP_BATCH_LIMIT = 500

/**
 * Fail runs stuck `running` past the cutoff (and their still-live steps).
 * Returns the reaped count.
 *
 * `onAfterRead` is a test-only seam: real callers never pass it. It runs
 * after the initial read (so its effects land in the gap the transaction's
 * re-checked `where` clauses are meant to protect against) and lets a test
 * simulate a run legitimately leaving `running` between the read and the
 * write — the exact race this function's re-query step exists to handle.
 */
export async function reapStuckFlowRuns(now = new Date(), onAfterRead?: () => Promise<void>): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_FLOW_RUN_TIMEOUT_MS)
  // systemPrisma: global reaper sweep — runs across all orgs by design (invoked from CRON_SECRET-gated dispatch).
  // 'stopping' is swept too: it means a stop was requested while an executor
  // was live — if that executor died before honoring it, the run would
  // otherwise sit in 'stopping' forever.
  const stuck = await systemPrisma.flowRun.findMany({
    where: { status: { in: ['running', 'stopping'] }, startedAt: { lt: cutoff } },
    select: { id: true },
    take: REAP_BATCH_LIMIT,
  })
  if (stuck.length === 0) return 0
  const runIds = stuck.map((run) => run.id)
  await onAfterRead?.()
  // systemPrisma: global reaper sweep — runs across all orgs by design.
  return systemPrisma.$transaction(async (tx) => {
    // Status re-checked here so a run that legitimately left `running`
    // (e.g. paused on a question) between the read above and this write is
    // left alone.
    const reaped = await tx.flowRun.updateMany({
      where: { id: { in: runIds }, status: { in: ['running', 'stopping'] } },
      data: { status: 'failed', error: STUCK_RUN_ERROR, finishedAt: now },
    })
    if (reaped.count === 0) return 0
    // Only fail steps belonging to runs THIS pass actually reaped — re-query
    // rather than reuse runIds, since a run this pass skipped (already
    // transitioned away from `running`) must keep its steps untouched.
    const reapedRuns = await tx.flowRun.findMany({
      where: { id: { in: runIds }, status: 'failed', error: STUCK_RUN_ERROR },
      select: { id: true },
    })
    await tx.flowRunStep.updateMany({
      where: { flowRunId: { in: reapedRuns.map((run) => run.id) }, status: { in: ['queued', 'running', 'waiting'] } },
      data: { status: 'failed', error: STUCK_RUN_ERROR, finishedAt: now },
    })
    return reaped.count
  })
}
