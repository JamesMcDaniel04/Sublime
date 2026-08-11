import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { recordUserEvent } from '@/lib/behavior/record-event'

type ObservationInput = {
  organizationId: string
  userId?: string | null
  flowId: string
  flowRunId: string
  status: string
  error?: string | null
}

function errorClass(message?: string | null): string | null {
  if (!message) return null
  if (/ambiguous|may have completed at the provider/i.test(message)) return 'ambiguous_side_effect'
  if (/timed? out|timeout/i.test(message)) return 'timeout'
  if (/rate.?limit|HTTP 429/i.test(message)) return 'rate_limit'
  if (/credential|unauthori[sz]ed|HTTP 401|HTTP 403/i.test(message)) return 'authorization'
  if (/validation|required|invalid/i.test(message)) return 'validation'
  return 'runtime'
}

/** Persist references-only run and step facts for recursive learning. */
export async function recordFlowObservations(input: ObservationInput): Promise<void> {
  const [run, steps, effects] = await Promise.all([
    prisma.flowRun.findFirst({
      where: { id: input.flowRunId, organizationId: input.organizationId },
      select: { id: true, startedAt: true, finishedAt: true, queueAttempt: true, trigger: true },
    }),
    prisma.flowRunStep.findMany({
      where: { flowRunId: input.flowRunId, run: { organizationId: input.organizationId } },
      select: { id: true, nodeId: true, iterationPath: true, status: true, error: true, startedAt: true, finishedAt: true },
    }),
    prisma.flowSideEffect.groupBy({
      by: ['status'],
      where: { flowRunId: input.flowRunId, organizationId: input.organizationId },
      _count: { _all: true },
    }),
  ])
  if (!run) return
  const finishedAt = run.finishedAt ?? new Date()
  const triggerType = run.trigger && typeof run.trigger === 'object' && !Array.isArray(run.trigger)
    ? String((run.trigger as Record<string, unknown>).type ?? 'unknown')
    : 'unknown'
  const effectCounts = Object.fromEntries(effects.map((row) => [row.status, row._count._all]))
  const outcome = input.error && errorClass(input.error) === 'ambiguous_side_effect' ? 'ambiguous' : input.status
  const rows = [
    {
      observationKey: `flow-run:${input.flowRunId}`,
      nodeId: null,
      kind: 'run_outcome',
      subject: `flow:${input.flowId}`,
      outcome,
      features: {
        triggerType,
        durationMs: Math.max(0, finishedAt.getTime() - run.startedAt.getTime()),
        queueAttempt: run.queueAttempt,
        stepCount: steps.length,
        effectCounts,
      },
      evidence: { flowRunId: input.flowRunId, errorClass: errorClass(input.error) },
      occurredAt: finishedAt,
    },
    ...steps.map((step) => ({
      observationKey: `flow-step:${step.id}`,
      nodeId: step.nodeId,
      kind: 'step_outcome',
      subject: `flow:${input.flowId}:node:${step.nodeId}`,
      outcome: step.error && errorClass(step.error) === 'ambiguous_side_effect' ? 'ambiguous' : step.status,
      features: {
        iteration: Boolean(step.iterationPath),
        durationMs: step.startedAt && step.finishedAt ? Math.max(0, step.finishedAt.getTime() - step.startedAt.getTime()) : null,
      },
      evidence: { flowRunId: input.flowRunId, stepId: step.id, errorClass: errorClass(step.error) },
      occurredAt: step.finishedAt ?? finishedAt,
    })),
  ]
  for (const row of rows) {
    await prisma.flowLearningObservation.upsert({
      where: { observationKey: row.observationKey },
      create: {
        ...row,
        organizationId: input.organizationId,
        userId: input.userId,
        flowId: input.flowId,
        flowRunId: input.flowRunId,
        features: row.features as Prisma.InputJsonValue,
        evidence: row.evidence as Prisma.InputJsonValue,
      },
      update: {
        outcome: row.outcome,
        features: row.features as Prisma.InputJsonValue,
        evidence: row.evidence as Prisma.InputJsonValue,
        occurredAt: row.occurredAt,
      },
    })
  }
  if (input.userId) {
    await recordUserEvent({
      organizationId: input.organizationId,
      userId: input.userId,
      kind: 'flow_run_outcome',
      resourceType: 'flow',
      resourceId: input.flowId,
      context: {
        flowRunId: input.flowRunId,
        outcome,
        triggerType,
        errorClass: errorClass(input.error),
        stepCount: steps.length,
        queueAttempt: run.queueAttempt,
      },
    })
  }
}

export { errorClass as flowObservationErrorClass }
