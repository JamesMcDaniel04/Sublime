/**
 * Running an external agent: dispatch, settle, and the deadline reaper.
 *
 * The runtime hands off here once the execution row exists. The run is either
 * settled from the endpoint's inline answer, or parked as
 * `waiting_for_external` until the callback route settles it — the same
 * status-guarded write from both, so a late callback after a cancel or a
 * timeout is a clean no-op rather than a resurrection.
 */
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'
import { notify } from '@/lib/notifications/service'
import { encryptRunText, encryptRunValue } from '@/lib/agents/run-crypto'
import { agentDisplayName } from '@/lib/agents/metadata'
import { moveAgentRequest } from '@/lib/agents/request-settle'
import { prismaGoalsPort } from '@/lib/integrations/goals-port'
import {
  authHeadersFor, buildExternalPayload, callbackUrlFor, dispatchToExternalAgent, mintCallbackToken, type ExternalOutcome,
} from './external-agent'

export const WAITING_FOR_EXTERNAL = 'waiting_for_external'

const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value ?? null))
const metadataOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export async function runExternalAgentRun(args: {
  organizationId: string
  userId: string
  agentId: string
  objective: string
  executionId: string
  input: string
  request: { id: string; text: string; requesterName: string | null; goalId: string | null } | null
  fetchImpl?: typeof fetch
}): Promise<{ status: string; executionId: string; summary?: string }> {
  const { organizationId, executionId, agentId } = args
  const binding = await prisma.externalAgentBinding.findFirst({ where: { agentTaskId: agentId, organizationId } })
  if (!binding) {
    await settleExternalRun({ organizationId, executionId, agentId, userId: args.userId, outcome: { kind: 'failed', error: 'This external agent has no endpoint configured.' }, requestId: args.request?.id ?? null })
    return { status: 'failed', executionId }
  }

  const { token, hash } = mintCallbackToken()
  const deadlineAt = new Date(Date.now() + binding.timeoutMinutes * 60_000).toISOString()
  const current = await prisma.agentExecution.findFirst({ where: { id: executionId, organizationId }, select: { metadata: true } })
  await prisma.agentExecution.updateMany({
    where: { id: executionId, organizationId },
    data: { metadata: jsonValue({ ...metadataOf(current?.metadata), externalCallbackHash: hash, externalDeadlineAt: deadlineAt }) },
  })
  await prisma.workflowEvent.create({ data: { executionId, kind: 'external.dispatched', payload: jsonValue({ host: safeHost(binding.endpointUrl) }) } })
  await recordAudit({
    organizationId, executionId, actorUserId: args.userId, actorAgentId: agentId, actorKind: 'agent',
    action: 'agent.external_dispatch', resourceType: 'external_agent', resourceId: binding.id, detail: { host: safeHost(binding.endpointUrl) },
  })

  const outcome = await dispatchToExternalAgent({
    endpointUrl: binding.endpointUrl,
    headers: authHeadersFor(binding),
    payload: buildExternalPayload({
      runId: executionId, agentId,
      request: args.request ? { id: args.request.id, text: args.request.text, requesterName: args.request.requesterName } : null,
      objective: args.objective, input: args.input, goalId: args.request?.goalId ?? null,
      callbackUrl: callbackUrlFor(agentId), callbackToken: token,
    }),
    fetchImpl: args.fetchImpl,
  })

  if (outcome.kind === 'accepted') {
    // Park. The reaper fails it at the deadline if nothing calls back.
    await prisma.agentExecution.updateMany({ where: { id: executionId, organizationId, status: 'running' }, data: { status: WAITING_FOR_EXTERNAL } })
    await prisma.workflowEvent.create({ data: { executionId, kind: 'external.accepted', payload: jsonValue({ deadlineAt }) } })
    return { status: WAITING_FOR_EXTERNAL, executionId }
  }
  await settleExternalRun({ organizationId, executionId, agentId, userId: args.userId, outcome, requestId: args.request?.id ?? null })
  return { status: outcome.kind === 'completed' ? 'completed' : 'failed', executionId, ...(outcome.kind === 'completed' ? { summary: outcome.output } : {}) }
}

/**
 * The one terminal write for an external run. Status-guarded so only a run
 * still in flight can be settled; the callback token is cleared with it, which
 * is what makes the token single-use.
 */
export async function settleExternalRun(args: {
  organizationId: string
  executionId: string
  agentId: string
  userId: string | null
  outcome: Exclude<ExternalOutcome, { kind: 'accepted' }>
  requestId: string | null
}): Promise<boolean> {
  const { organizationId, executionId, agentId, outcome } = args
  const current = await prisma.agentExecution.findFirst({ where: { id: executionId, organizationId }, select: { metadata: true } })
  const metadata = { ...metadataOf(current?.metadata), externalCallbackHash: null, externalDeadlineAt: null }
  const completed = outcome.kind === 'completed'
  const claim = await prisma.agentExecution.updateMany({
    where: { id: executionId, organizationId, status: { in: ['running', WAITING_FOR_EXTERNAL] } },
    data: completed
      ? { status: 'completed', output: encryptRunValue({ summary: outcome.output }), completedAt: new Date(), metadata: jsonValue(metadata) }
      : { status: 'failed', error: outcome.error.slice(0, 300), completedAt: new Date(), metadata: jsonValue(metadata) },
  })
  if (claim.count === 0) return false

  await prisma.executionMessage.create({ data: { executionId, role: 'agent', content: encryptRunText(completed ? outcome.output : outcome.error) } }).catch(() => undefined)
  await prisma.workflowEvent.create({ data: { executionId, kind: completed ? 'external.completed' : 'external.failed', payload: jsonValue(completed ? {} : { error: outcome.error }) } }).catch(() => undefined)
  const agent = await prisma.agentTask.findFirst({ where: { id: agentId, organizationId }, select: { id: true, description: true, metadata: true } })
  if (completed) {
    await prisma.agentTask.updateMany({ where: { id: agentId, organizationId }, data: { lastExecutedAt: new Date(), executionCount: { increment: 1 }, lastResult: jsonValue({ summary: outcome.output }) } }).catch(() => undefined)
  }

  // Work the agent declared lands on the request's goal through the same
  // path a native agent's log_work takes — it enters the disposition ledger
  // and the rule learning like any other agent output. Deliberate, not
  // automatic: an answer without `work` stays an answer. Without a goal there
  // is nowhere for it to land, and the run says so rather than losing it
  // silently.
  if (completed && outcome.work.length > 0) {
    const request = args.requestId
      ? await prisma.agentRequest.findFirst({ where: { id: args.requestId, organizationId }, select: { goalId: true } })
      : null
    const goalId = request?.goalId ?? null
    if (!goalId) {
      await prisma.workflowEvent.create({ data: { executionId, kind: 'external.work_dropped', payload: jsonValue({ count: outcome.work.length, reason: 'the request names no goal' }) } }).catch(() => undefined)
    } else {
      const port = prismaGoalsPort(organizationId, { type: 'agent', id: agentId })
      let logged = 0
      for (const entry of outcome.work) {
        try {
          await port.writeWork(goalId, {
            subject: entry.subject, subjectRef: entry.subjectRef, produced: entry.produced, body: entry.body,
            bodyFormat: entry.bodyFormat, assigneeHint: entry.assigneeHint, signals: null, probeRuleId: null,
          })
          logged += 1
        } catch (error) {
          apiLogger.warn('external work entry not logged', { executionId, goalId, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await prisma.workflowEvent.create({ data: { executionId, kind: 'external.work_logged', payload: jsonValue({ goalId, count: logged, of: outcome.work.length }) } }).catch(() => undefined)
    }
  }

  if (args.requestId) {
    await moveAgentRequest({
      requestId: args.requestId, organizationId, to: completed ? 'completed' : 'failed', executionId,
      ...(completed ? { result: outcome.output } : { error: outcome.error }),
    }).catch((error) => apiLogger.error('external request settle failed', { requestId: args.requestId, error: error instanceof Error ? error.message : String(error) }))
  } else if (args.userId) {
    const name = agent ? agentDisplayName(agent) : 'The external agent'
    await notify({
      organizationId, userId: args.userId, executionId, agentTaskId: agentId,
      type: completed ? 'agent.completed' : 'agent.error', level: completed ? 'success' : 'error',
      title: completed ? `${name} completed` : `${name} hit an error`,
      body: completed ? outcome.output.slice(0, 2000) : outcome.error,
    })
  }
  return true
}

/**
 * Cron: fail parked runs whose deadline passed. The stuck-run reaper ignores
 * `waiting_for_external` on purpose — this is its reaper.
 * systemPrisma: a global sweep across every org (CRON_SECRET-gated caller).
 */
export async function reapExternalTimeouts(now: Date = new Date()): Promise<number> {
  const rows = await systemPrisma.agentExecution.findMany({
    where: { status: WAITING_FOR_EXTERNAL },
    select: { id: true, organizationId: true, agentTaskId: true, userId: true, metadata: true, trigger: true },
    take: 500,
  })
  let reaped = 0
  for (const row of rows) {
    const deadline = metadataOf(row.metadata).externalDeadlineAt
    if (typeof deadline !== 'string' || new Date(deadline).getTime() > now.getTime()) continue
    if (!row.organizationId || !row.agentTaskId) continue
    const trigger = metadataOf(row.trigger)
    const settled = await settleExternalRun({
      organizationId: row.organizationId, executionId: row.id, agentId: row.agentTaskId, userId: row.userId,
      outcome: { kind: 'failed', error: 'The external agent never called back before its deadline.' },
      requestId: typeof trigger.requestId === 'string' ? trigger.requestId : null,
    }).catch(() => false)
    if (settled) reaped += 1
  }
  return reaped
}

function safeHost(url: string): string {
  try { return new URL(url).host } catch { return 'invalid' }
}
