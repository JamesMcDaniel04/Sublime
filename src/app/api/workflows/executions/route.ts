import { prisma } from '@/lib/prisma'
import { decryptRunText, decryptRunValue } from '@/lib/agents/run-crypto'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = request.nextUrl.searchParams.get('agentId') || undefined
  const executionId = request.nextUrl.searchParams.get('executionId') || undefined
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 5, 25)
  const visibility = executionVisibilityScope(auth.dbUser.id)

  const executions = executionId
    ? await prisma.agentExecution.findMany({
        where: { id: executionId, organizationId: auth.organizationId, ...visibility },
        omit: { transcript: true },
        take: 1,
      })
    : await prisma.agentExecution.findMany({
        where: {
          organizationId: auth.organizationId,
          ...(agentId ? { agentTaskId: agentId } : {}),
          ...visibility,
        },
        omit: { transcript: true },
        orderBy: { startedAt: 'desc' },
        take: limit,
      })

  const ids = executions.map((execution) => execution.id)
  // Bounded child fetches, newest-first then re-sorted ascending: this
  // endpoint is polled every 2s while a run is live, and a long multi-turn
  // run accumulates hundreds of JSON-carrying events — unbounded, the whole
  // set re-transferred in full on every tick, growing for the run's entire
  // duration. Keeping the newest N preserves what live UIs render.
  const [steps, events, messages] = ids.length
    ? await Promise.all([
        prisma.workflowStep
          .findMany({
            where: { executionId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            take: 300,
          })
          .then((rows) => rows.reverse()),
        prisma.workflowEvent
          .findMany({
            where: { executionId: { in: ids } },
            orderBy: { ts: 'desc' },
            take: 500,
          })
          .then((rows) => rows.reverse()),
        prisma.executionMessage
          .findMany({
            where: { executionId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            take: 200,
          })
          .then((rows) => rows.reverse()),
      ])
    : [[], [], []]

  const items = executions.map((execution) => ({
    // Run data is encrypted at rest — decrypt input/output/plan (and message
    // content below) back to their object/text form before serving. Identity
    // for legacy plaintext rows. Transcript is omitted from this endpoint.
    execution: {
      ...execution,
      input: decryptRunValue(execution.input),
      output: decryptRunValue(execution.output),
      plan: decryptRunValue(execution.plan),
    },
    steps: steps.filter((step) => step.executionId === execution.id),
    events: events.filter((event) => event.executionId === execution.id),
    messages: messages
      .filter((message) => message.executionId === execution.id)
      .map((message) => ({ ...message, content: decryptRunText(message.content) })),
  }))

  return { success: true, items }
}, { requires: 'member' })
