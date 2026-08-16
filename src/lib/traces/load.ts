/**
 * Shared Prisma loaders + wire adapters for trace detail routes: batched
 * events/steps reads (one query per table regardless of execution count) and
 * the row→ProcessEvent/ProcessToolStep shaping both detail endpoints need.
 * Kept out of the route files so the flow route's child-execution nesting
 * reuses exactly the agent route's shaping.
 */
import { prisma } from '@/lib/prisma'
import type { ProcessEvent, ProcessToolStep } from '@/lib/agents/process-feed'
import { redactDeep } from '@/lib/export/redact'

/** Same bounds as GET /api/workflows/executions: newest N, re-sorted ascending. */
const EVENT_LIMIT = 500
const STEP_LIMIT = 300

export type WorkflowEventRow = { id: string; executionId: string; kind: string; payload: unknown; ts: Date }
export type WorkflowStepRow = {
  id: string
  executionId: string
  node: string
  status: string
  input: unknown
  output: unknown
  error: unknown
  startedAt: Date | null
  completedAt: Date | null
}

export async function loadAgentTraceParts(executionIds: string[]): Promise<{
  events: WorkflowEventRow[]
  steps: WorkflowStepRow[]
}> {
  if (executionIds.length === 0) return { events: [], steps: [] }
  const [events, steps] = await Promise.all([
    prisma.workflowEvent
      .findMany({
        where: { executionId: { in: executionIds } },
        orderBy: { ts: 'desc' },
        take: EVENT_LIMIT,
      })
      .then((rows) => rows.reverse()),
    prisma.workflowStep
      .findMany({
        where: { executionId: { in: executionIds } },
        orderBy: { createdAt: 'desc' },
        take: STEP_LIMIT,
      })
      .then((rows) => rows.reverse()),
  ])
  return { events, steps }
}

export function toProcessEvents(rows: WorkflowEventRow[]): ProcessEvent[] {
  return rows.map((row) => ({ id: row.id, kind: row.kind, payload: row.payload, ts: row.ts.toISOString() }))
}

/**
 * Redact where the row is SERVED, not where it is written.
 *
 * The step row is deliberately persisted in full: agent replay keys off
 * `toolStepKey(node, input)` and re-uses `output` as the cached result
 * (loadCompletedToolSteps), and a flow resume rebuilds its `completed` map
 * from `step.output` (resolveResumeState). Redacting at write time would
 * change the replay hash — re-firing an already-executed write tool — and feed
 * downstream templates the literal string 'redacted'.
 *
 * So the row stays intact for the engine, and every path that hands it to a
 * PERSON redacts on the way out. Name-based (`redactDeep`), matching exports:
 * a key that names a credential is redacted wherever it appears, however deep,
 * including inside JSON-encoded strings.
 */
export function toProcessSteps(rows: WorkflowStepRow[]): ProcessToolStep[] {
  return rows.map((row) => ({
    id: row.id,
    node: row.node,
    status: row.status,
    input: redactDeep(row.input),
    output: redactDeep(row.output),
    error: redactDeep(row.error),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  }))
}

/** Agent display name: metadata title, else first description line, else type. */
export function agentTraceName(execution: {
  agentType: string
  agentTask: { description: string; metadata: unknown } | null
}): string {
  return (
    (execution.agentTask?.metadata as { title?: string } | null)?.title ||
    execution.agentTask?.description.split('\n')[0] ||
    execution.agentType
  )
}
