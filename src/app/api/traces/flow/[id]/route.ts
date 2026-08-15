import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { workspaceFlowRunScope } from '@/lib/server/visibility'
import { costRateFor } from '@/lib/goals/impact'
import { traceFromAgentExecution, traceFromFlowRun, type TraceDetail } from '@/lib/traces/spans'
import { agentTraceName, loadAgentTraceParts, toProcessEvents, toProcessSteps } from '@/lib/traces/load'

export const runtime = 'nodejs'

const idFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-1) ?? '')

// GET /api/traces/flow/[id] — one flow run as a trace, with each agent step's
// child execution nested as a subagent span (one batched load, not per-step).
// Children are NOT re-filtered by user visibility: a visible flow run's own
// steps are part of that run's story. Missing/foreign runs → 404, never 403.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const run = await prisma.flowRun.findFirst({
    where: {
      id,
      organizationId: auth.organizationId,
      ...workspaceFlowRunScope(auth.dbUser.id),
    },
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      trigger: true,
      flow: { select: { name: true } },
      steps: { orderBy: { order: 'asc' } },
    },
  })
  if (!run) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const [rate, effects] = await Promise.all([
    costRateFor(auth.organizationId),
    prisma.flowSideEffect.findMany({
      where: { flowRunId: id, organizationId: auth.organizationId },
      select: {
        flowRunStepId: true,
        provider: true,
        operation: true,
        safety: true,
        status: true,
        attempts: true,
      },
    }),
  ])
  const childIds = run.steps
    .map((step: { agentExecutionId: string | null }) => step.agentExecutionId)
    .filter((childId: string | null): childId is string => Boolean(childId))
  const children = new Map<string, TraceDetail>()
  if (childIds.length > 0) {
    const [executions, parts] = await Promise.all([
      prisma.agentExecution.findMany({
        where: { id: { in: childIds }, organizationId: auth.organizationId },
        omit: { transcript: true },
        include: { agentTask: { select: { description: true, metadata: true } } },
      }),
      loadAgentTraceParts(childIds),
    ])
    for (const execution of executions) {
      children.set(
        execution.id,
        traceFromAgentExecution(
          execution,
          toProcessEvents(parts.events.filter((event) => event.executionId === execution.id)),
          toProcessSteps(parts.steps.filter((step) => step.executionId === execution.id)),
          { name: agentTraceName(execution), perMTokensUsd: rate },
        ),
      )
    }
  }
  const trace = traceFromFlowRun(run, run.steps, effects, children, { name: run.flow.name })
  return { success: true, trace }
}, { requires: 'member' })
