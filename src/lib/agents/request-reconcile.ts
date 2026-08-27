/**
 * Reconcile AgentRequest rows whose run settled without settling them.
 *
 * The happy path settles a request from inside the run (request-settle.ts).
 * Every other way a run can end — the stuck-run reaper, the pending reaper,
 * a dead-lettered job, a worker killed between the completion claim and the
 * settle write — terminalizes the EXECUTION and leaves the REQUEST pointing at
 * it, still saying "Working…" to the person who asked. This sweep is the
 * catch-all: any open request whose execution has already reached a terminal
 * state is moved to match.
 *
 * Split into a pure planner and a thin runner so the rules are unit-testable
 * without a database, in the same shape as eligibility.ts and work-transitions.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { moveAgentRequest } from './request-settle'
import type { RequestStatus } from './request-transitions'

export type ReconcilableRequest = {
  id: string
  organizationId: string
  status: string
  executionId: string | null
  createdAt: Date
}

export type ExecutionState = {
  id: string
  status: string
  error: string | null
}

export type ReconcileMove = {
  requestId: string
  organizationId: string
  to: RequestStatus
  executionId: string | null
  error?: string
  /** For the log line — why this request moved. */
  reason: string
}

/**
 * A request that never got a run linked (dispatch died between the request
 * insert and the execution insert) cannot be resolved by looking at a run.
 * After this long it is failed rather than left "Queued" forever.
 */
export const ORPHAN_REQUEST_TIMEOUT_MS = 60 * 60 * 1000

const OPEN_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

/** Pure: which requests must move, and to what. Never touches I/O. */
export function planRequestReconciliation(
  requests: ReconcilableRequest[],
  executionsById: Map<string, ExecutionState>,
  now: Date = new Date(),
): ReconcileMove[] {
  const moves: ReconcileMove[] = []
  for (const request of requests) {
    if (!OPEN_STATUSES.has(request.status)) continue
    const base = { requestId: request.id, organizationId: request.organizationId, executionId: request.executionId }

    if (!request.executionId) {
      if (now.getTime() - request.createdAt.getTime() > ORPHAN_REQUEST_TIMEOUT_MS) {
        moves.push({ ...base, to: 'failed', error: 'The run never started.', reason: 'orphan: no run linked past timeout' })
      }
      continue
    }

    const execution = executionsById.get(request.executionId)
    if (!execution) {
      // Retention pruned the run out from under an open request. Nothing can
      // answer it now; say so rather than spin forever.
      moves.push({ ...base, to: 'failed', error: 'The run record no longer exists.', reason: 'execution missing' })
      continue
    }

    switch (execution.status) {
      case 'failed':
        moves.push({ ...base, to: 'failed', error: execution.error ?? 'The run failed.', reason: 'execution failed' })
        break
      case 'cancelled':
        moves.push({ ...base, to: 'cancelled', reason: 'execution cancelled' })
        break
      case 'completed':
        // The runner fills in the answer; the planner only knows it settled.
        moves.push({ ...base, to: 'completed', reason: 'execution completed without settling the request' })
        break
      case 'waiting_for_input':
      case 'waiting_for_approval':
        if (request.status !== 'waiting') moves.push({ ...base, to: 'waiting', reason: 'execution is waiting on a human' })
        break
      case 'running':
      case 'cancelling':
        if (request.status !== 'running') moves.push({ ...base, to: 'running', reason: 'execution is running' })
        break
      default:
        // pending: the job is queued and will run. Leave it.
        break
    }
  }
  return moves
}

/** How many open requests one tick inspects. Bounded like every other sweep. */
const SWEEP_LIMIT = 500

/**
 * Runner. systemPrisma: a global sweep across every org by design (the cron
 * tick is CRON_SECRET-gated); each individual move still carries its own
 * organizationId into the guarded settle path.
 */
export async function reconcileStrandedRequests(
  readSummary: (executionId: string) => Promise<string | null>,
  now: Date = new Date(),
): Promise<number> {
  const requests = await systemPrisma.agentRequest.findMany({
    where: { status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_LIMIT,
    select: { id: true, organizationId: true, status: true, executionId: true, createdAt: true },
  })
  if (requests.length === 0) return 0

  const executionIds = requests.map((r) => r.executionId).filter((id): id is string => Boolean(id))
  const executions = executionIds.length
    ? await systemPrisma.agentExecution.findMany({
        where: { id: { in: executionIds } },
        select: { id: true, status: true, error: true },
      })
    : []
  const executionsById = new Map(executions.map((e) => [e.id, e]))

  const moves = planRequestReconciliation(requests, executionsById, now)
  let moved = 0
  for (const move of moves) {
    const result =
      move.to === 'completed' && move.executionId
        ? await readSummary(move.executionId).catch(() => null)
        : undefined
    const didMove = await moveAgentRequest({
      requestId: move.requestId,
      organizationId: move.organizationId,
      to: move.to,
      executionId: move.executionId,
      ...(move.error !== undefined ? { error: move.error } : {}),
      ...(result !== undefined ? { result: result ?? 'The run finished. Open it to see the answer.' } : {}),
    }).catch((error) => {
      apiLogger.warn('request reconciliation move failed', {
        requestId: move.requestId,
        to: move.to,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    })
    if (didMove) {
      moved += 1
      apiLogger.info('request reconciled', { requestId: move.requestId, to: move.to, reason: move.reason })
    }
  }
  return moved
}
