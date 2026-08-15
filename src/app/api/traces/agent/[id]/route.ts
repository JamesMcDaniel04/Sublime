import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'
import { costRateFor } from '@/lib/goals/impact'
import { traceFromAgentExecution } from '@/lib/traces/spans'
import { agentTraceName, loadAgentTraceParts, toProcessEvents, toProcessSteps } from '@/lib/traces/load'

export const runtime = 'nodejs'

const idFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-1) ?? '')

// GET /api/traces/agent/[id] — one agent execution as a trace. Missing,
// foreign-org, and other-user runs are all the same 404: absence, never 403.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const execution = await prisma.agentExecution.findFirst({
    where: { id, organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
    omit: { transcript: true },
    include: { agentTask: { select: { description: true, metadata: true } } },
  })
  if (!execution) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const [rate, parts] = await Promise.all([
    costRateFor(auth.organizationId),
    loadAgentTraceParts([id]),
  ])
  const trace = traceFromAgentExecution(
    execution,
    toProcessEvents(parts.events),
    toProcessSteps(parts.steps),
    { name: agentTraceName(execution), perMTokensUsd: rate },
  )
  return { success: true, trace }
}, { requires: 'member' })
