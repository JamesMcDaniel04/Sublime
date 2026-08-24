/**
 * The legal moves on an AgentRequest. Pure, so the API route, the worker's
 * settle path, and the UI cannot disagree about what is allowed, and so every
 * refusal is unit-testable.
 *
 * The load-bearing rule is that settled is terminal. BullMQ redelivers jobs,
 * and a resumed run settles on a path the original claim also travels — so
 * without a one-way gate a redelivered job would overwrite a request that was
 * already answered, or resurrect one a human cancelled. Refusing the move is
 * what lets settleAgentRequest be a safe no-op rather than a second answer.
 */

export const REQUEST_STATUSES = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'declined',
  'cancelled',
] as const

export type RequestStatus = (typeof REQUEST_STATUSES)[number]

/** Settled: the request has its answer (or its refusal) and moves no more. */
const TERMINAL: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  'completed',
  'failed',
  'declined',
  'cancelled',
])

export const isTerminal = (status: RequestStatus): boolean => TERMINAL.has(status)

/**
 * Where each status may go next.
 *
 * `pending` reaches only `running`, `cancelled`, or `failed`: a request that
 * never ran cannot have an answer, and `declined` is a judgment the agent
 * makes inside the run via the decline_request tool — not something the
 * enqueue path can conclude on its own.
 */
const MOVES: Record<RequestStatus, ReadonlySet<RequestStatus>> = {
  pending: new Set<RequestStatus>(['pending', 'running', 'cancelled', 'failed']),
  running: new Set<RequestStatus>(['running', 'waiting', 'completed', 'failed', 'declined', 'cancelled']),
  waiting: new Set<RequestStatus>(['waiting', 'running', 'completed', 'failed', 'declined', 'cancelled']),
  completed: new Set<RequestStatus>(),
  failed: new Set<RequestStatus>(),
  declined: new Set<RequestStatus>(),
  cancelled: new Set<RequestStatus>(),
}

const known = (status: RequestStatus) => (REQUEST_STATUSES as readonly string[]).includes(status)

/** `null` when the move is allowed; otherwise the reason to refuse it. */
export function refuseTransition(from: RequestStatus, to: RequestStatus): string | null {
  if (!known(from)) return `Unknown request status "${from}".`
  if (!known(to)) return `Unknown request status "${to}".`
  if (isTerminal(from)) return `This request already settled as "${from}".`
  if (!MOVES[from].has(to)) {
    if (to === 'completed' || to === 'declined') {
      return `A request that has not run cannot be "${to}".`
    }
    return `A request cannot move from "${from}" to "${to}".`
  }
  return null
}

/**
 * Every status from which `to` is reachable.
 *
 * This exists so the database guard and the rules above cannot drift: the
 * settle path updates with `status: { in: sourcesFor(to) }` in its WHERE
 * clause, which makes the terminal gate atomic rather than a read-then-write
 * race two concurrent job deliveries could both win.
 */
export function sourcesFor(to: RequestStatus): RequestStatus[] {
  return REQUEST_STATUSES.filter((from) => refuseTransition(from, to) === null)
}

