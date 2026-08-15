/**
 * Projection mappers: one AgentExecution or FlowRun (plus its child rows)
 * → the shared TraceDetail envelope. Pure and throw-free: run traces render
 * whatever the stores hold, so a malformed event payload degrades to an
 * `unknown` span instead of taking the trace surface down with it.
 *
 * Wire-shape note: `context.retrieved` / `knowledge.retrieved` events written
 * before the 2026-08 enrichment lack query/stages/injected and per-hit
 * scores — those fields are nullable here and the UI hides what is absent.
 */
import type { ProcessEvent, ProcessToolStep } from '@/lib/agents/process-feed'
import type { RetrievalTrace } from '@/lib/rag/retrieve'
import {
  costUsdOf,
  normalizeAgentStatus,
  normalizeFlowStatus,
  type TraceStatus,
  type TraceSummary,
} from './envelope'

export type TraceSpan =
  | { kind: 'thinking'; ts: number; text: string }
  | { kind: 'plan'; ts: number; text: string }
  | {
      kind: 'retrieval'
      ts: number
      channel: 'graph-rag' | 'knowledge'
      strategy: string | null
      query: string | null
      summary: string
      hits: Array<{ type: string; text: string; score: number | null }>
      related: Array<{ type: string; text: string }>
      stages: RetrievalTrace | null
      injected: { count: number; ofCandidates: number; tokens: number } | null
    }
  | { kind: 'memory'; ts: number; summary: string }
  | { kind: 'autoanswer'; ts: number; question: string; answer: string }
  | { kind: 'tool'; ts: number; step: ProcessToolStep }
  | {
      kind: 'step'
      ts: number
      node: string
      status: TraceStatus
      iterationPath: string | null
      input?: unknown
      output?: unknown
      error: string | null
      effects: Array<{ provider: string; operation: string; safety: string; status: string; attempts: number }>
    }
  | { kind: 'subagent'; ts: number; nodeId: string; trace: TraceDetail }
  | { kind: 'unknown'; ts: number; label: string }

export type TraceDetail = { summary: TraceSummary; spans: TraceSpan[] }

export type AgentExecutionRow = {
  id: string
  status: string
  startedAt: Date | string
  completedAt: Date | string | null
  inputTokens: number
  outputTokens: number
  error: string | null
  trigger: unknown
}

export type FlowRunRow = {
  id: string
  status: string
  startedAt: Date | string
  finishedAt: Date | string | null
  error: string | null
  trigger: unknown
}

export type FlowStepRow = {
  id: string
  nodeId: string
  agentExecutionId: string | null
  iterationPath: string | null
  order: number
  status: string
  input?: unknown
  output?: unknown
  error: string | null
  startedAt: Date | string | null
  finishedAt: Date | string | null
}

export type FlowEffectRow = {
  flowRunStepId: string
  provider: string
  operation: string
  safety: string
  status: string
  attempts: number
}

const tsOf = (value: Date | string | null | undefined): number => {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

const iso = (value: Date | string): string => new Date(value).toISOString()

const triggerOf = (trigger: unknown): string | null => {
  const type = (trigger as { type?: unknown } | null)?.type
  return typeof type === 'string' ? type : null
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)

const retrievalHits = (value: unknown): Array<{ type: string; text: string; score: number | null }> =>
  Array.isArray(value)
    ? value.map((hit) => ({
        type: str((hit as { type?: unknown })?.type) ?? 'fact',
        text: str((hit as { text?: unknown })?.text) ?? '',
        score: num((hit as { score?: unknown })?.score),
      }))
    : []

const injectedOf = (value: unknown): { count: number; ofCandidates: number; tokens: number } | null => {
  const injected = value as { count?: unknown; ofCandidates?: unknown; tokens?: unknown } | null
  return injected && typeof injected.count === 'number'
    ? {
        count: injected.count,
        ofCandidates: num(injected.ofCandidates) ?? injected.count,
        tokens: num(injected.tokens) ?? 0,
      }
    : null
}

/** Map one WorkflowEvent to a span; malformed payloads become `unknown`. */
function mapEvent(event: ProcessEvent): TraceSpan | null {
  const ts = tsOf(event.ts)
  try {
    const payload = event.payload as Record<string, unknown> | null | undefined
    switch (event.kind) {
      case 'agent.thinking': {
        const text = str(payload?.text)
        return text ? { kind: 'thinking', ts, text } : null
      }
      case 'agent.plan': {
        const text = str(payload?.text)
        return text ? { kind: 'plan', ts, text } : null
      }
      case 'context.retrieved':
        return {
          kind: 'retrieval',
          ts,
          channel: 'graph-rag',
          strategy: str(payload?.strategy),
          query: str(payload?.query),
          summary: str(payload?.summary) ?? 'Retrieved correlated context',
          hits: retrievalHits(payload?.hits),
          related: retrievalHits(payload?.related).map(({ type, text }) => ({ type, text })),
          stages: (payload?.stages as RetrievalTrace | undefined) ?? null,
          injected: injectedOf(payload?.injected),
        }
      case 'knowledge.retrieved':
        return {
          kind: 'retrieval',
          ts,
          channel: 'knowledge',
          strategy: null,
          query: str(payload?.query),
          summary: str(payload?.summary) ?? 'Retrieved file knowledge',
          // Legacy events carry only filenames; enriched ones score each chunk.
          hits: Array.isArray(payload?.chunks)
            ? (payload.chunks as Array<{ filename?: unknown; score?: unknown }>).map((chunk) => ({
                type: 'file',
                text: str(chunk?.filename) ?? '',
                score: num(chunk?.score),
              }))
            : Array.isArray(payload?.files)
              ? (payload.files as unknown[]).map((file) => ({ type: 'file', text: str(file) ?? '', score: null }))
              : [],
          related: [],
          stages: null,
          injected: injectedOf(payload?.injected),
        }
      case 'memory.retrieved': {
        const summary = str(payload?.summary)
        return summary ? { kind: 'memory', ts, summary } : null
      }
      case 'agent.question.autoanswered':
        return {
          kind: 'autoanswer',
          ts,
          question: str(payload?.question) ?? '',
          answer: str(payload?.answer) ?? '',
        }
      default:
        return null
    }
  } catch {
    return { kind: 'unknown', ts, label: event.kind }
  }
}

export function traceFromAgentExecution(
  execution: AgentExecutionRow,
  events: ProcessEvent[],
  steps: ProcessToolStep[],
  opts: { name: string; perMTokensUsd: number },
): TraceDetail {
  const spans: TraceSpan[] = []
  for (const event of events ?? []) {
    // A payload of the wrong shape entirely (e.g. a bare string) still yields
    // a span: the reader should see THAT something happened even when the
    // what is unreadable.
    const mapped =
      mapEvent(event) ??
      (event.payload !== undefined && typeof event.payload !== 'object'
        ? ({ kind: 'unknown', ts: tsOf(event.ts), label: event.kind } as TraceSpan)
        : null)
    if (mapped) spans.push(mapped)
  }
  for (const step of steps ?? []) {
    spans.push({ kind: 'tool', ts: tsOf(step.startedAt), step })
  }
  spans.sort((a, b) => a.ts - b.ts)
  const durationMs = execution.completedAt ? tsOf(execution.completedAt) - tsOf(execution.startedAt) : null
  return {
    summary: {
      id: execution.id,
      kind: 'agent',
      name: opts.name,
      status: normalizeAgentStatus(execution.status, execution.completedAt),
      startedAt: iso(execution.startedAt),
      finishedAt: execution.completedAt ? iso(execution.completedAt) : null,
      durationMs,
      tokens: { input: execution.inputTokens, output: execution.outputTokens },
      costUsd: costUsdOf(execution.inputTokens, execution.outputTokens, opts.perMTokensUsd),
      toolCallCount: steps?.length ?? 0,
      hasRetrieval: spans.some((span) => span.kind === 'retrieval'),
      trigger: triggerOf(execution.trigger),
      error: execution.error,
    },
    spans,
  }
}

export function traceFromFlowRun(
  run: FlowRunRow,
  steps: FlowStepRow[],
  effects: FlowEffectRow[],
  children: Map<string, TraceDetail>,
  opts: { name: string },
): TraceDetail {
  const effectsByStep = new Map<string, FlowEffectRow[]>()
  for (const effect of effects ?? []) {
    const list = effectsByStep.get(effect.flowRunStepId) ?? []
    list.push(effect)
    effectsByStep.set(effect.flowRunStepId, list)
  }
  const ordered = [...(steps ?? [])].sort(
    (a, b) => a.order - b.order || (a.iterationPath ?? '').localeCompare(b.iterationPath ?? ''),
  )
  const spans: TraceSpan[] = ordered.map((step) => {
    const child = step.agentExecutionId ? children.get(step.agentExecutionId) : undefined
    if (child) {
      return { kind: 'subagent', ts: tsOf(step.startedAt), nodeId: step.nodeId, trace: child }
    }
    return {
      kind: 'step',
      ts: tsOf(step.startedAt),
      node: step.nodeId,
      status: normalizeFlowStatus(step.status, step.finishedAt),
      iterationPath: step.iterationPath,
      input: step.input,
      output: step.output,
      error: step.error,
      effects: (effectsByStep.get(step.id) ?? []).map((effect) => ({
        provider: effect.provider,
        operation: effect.operation,
        safety: effect.safety,
        status: effect.status,
        attempts: effect.attempts,
      })),
    }
  })
  const childTraces = [...children.values()]
  const tokens = childTraces.length
    ? childTraces.reduce(
        (sum, child) => ({
          input: sum.input + (child.summary.tokens?.input ?? 0),
          output: sum.output + (child.summary.tokens?.output ?? 0),
        }),
        { input: 0, output: 0 },
      )
    : null
  const costUsd = childTraces.length
    ? childTraces.reduce((sum, child) => sum + (child.summary.costUsd ?? 0), 0)
    : null
  return {
    summary: {
      id: run.id,
      kind: 'flow',
      name: opts.name,
      status: normalizeFlowStatus(run.status, run.finishedAt),
      startedAt: iso(run.startedAt),
      finishedAt: run.finishedAt ? iso(run.finishedAt) : null,
      durationMs: run.finishedAt ? tsOf(run.finishedAt) - tsOf(run.startedAt) : null,
      tokens,
      costUsd,
      toolCallCount: ordered.length,
      hasRetrieval: childTraces.some((child) => child.summary.hasRetrieval),
      trigger: triggerOf(run.trigger),
      error: run.error,
    },
    spans,
  }
}
