/**
 * The shared trace vocabulary: one status set and one summary shape over both
 * run stores (AgentExecution, FlowRun). Pure — no Prisma, no React — so both
 * API routes and UI import it freely. Normalization NEVER throws: an unknown
 * source status degrades by terminal-ness so a new runtime status renders as
 * a live/failed run instead of crashing the trace surface.
 */

export type TraceStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'stopped'
export type TraceKind = 'agent' | 'flow'

export type TraceSummary = {
  id: string
  kind: TraceKind
  name: string
  status: TraceStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  /** Null for flow runs with no agent steps (flows themselves consume no tokens). */
  tokens: { input: number; output: number } | null
  costUsd: number | null
  toolCallCount: number
  hasRetrieval: boolean
  trigger: string | null
  error: string | null
}

const AGENT_STATUS: Record<string, TraceStatus> = {
  pending: 'queued',
  running: 'running',
  waiting_for_input: 'waiting',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'stopped',
  cancelling: 'stopped',
}

const FLOW_STATUS: Record<string, TraceStatus> = {
  queued: 'queued',
  claimed: 'queued',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'succeeded',
  failed: 'failed',
  stopping: 'stopped',
  stopped: 'stopped',
}

const fallback = (finished: Date | string | null): TraceStatus => (finished ? 'failed' : 'running')

export function normalizeAgentStatus(status: string, completedAt: Date | string | null): TraceStatus {
  return AGENT_STATUS[status] ?? fallback(completedAt)
}

export function normalizeFlowStatus(status: string, finishedAt: Date | string | null): TraceStatus {
  return FLOW_STATUS[status] ?? fallback(finishedAt)
}

/** `—`, `840ms`, `4.2s`, `3m 12s`, `1h 4m`. */
export function fmtDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Same cost model as lib/goals/impact.ts: tokens / 1M × the workspace rate. */
export function costUsdOf(inputTokens: number, outputTokens: number, perMTokensUsd: number): number {
  return ((inputTokens + outputTokens) / 1_000_000) * perMTokensUsd
}
