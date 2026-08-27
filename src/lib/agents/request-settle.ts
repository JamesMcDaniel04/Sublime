/**
 * The one place an AgentRequest changes status.
 *
 * Every move goes through a single status-guarded updateMany whose WHERE
 * clause is derived from the pure transition rules (`sourcesFor`). That makes
 * the terminal gate ATOMIC: two concurrent deliveries of the same job both
 * issue the update, Postgres serializes them, and exactly one sees count > 0.
 * The loser is a no-op rather than a second answer overwriting the first —
 * the same discipline the run-claim path uses.
 *
 * Side effects (notify, Slack reply) fire only for the caller that actually
 * won the move, and never throw into it: a request is settled the moment the
 * row says so, whether or not anyone was successfully told.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { notify } from '@/lib/notifications/service'
import { slackOriginOf } from '@/lib/slack/reply'
import { agentDisplayName, readAgentMetadata } from '@/lib/agents/metadata'
import { avatarSeedFor } from '@/lib/agents/avatar'
import { portraitFor } from '@/lib/agents/avatar-portraits'
import { deliverRequestSlackReply, type RequestReplyStatus } from './request-slack-reply'
import { isTerminal, sourcesFor, type RequestStatus } from './request-transitions'

export type MoveAgentRequestInput = {
  requestId: string
  organizationId: string
  to: RequestStatus
  executionId?: string | null
  result?: string | null
  error?: string | null
  /** The pending `ask_user` question, when moving to `waiting`. */
  question?: string | null
}

/** True when THIS call moved the request; false when it had already moved on. */
export async function moveAgentRequest(input: MoveAgentRequestInput): Promise<boolean> {
  const { requestId, organizationId, to } = input

  const { count } = await prisma.agentRequest.updateMany({
    where: { id: requestId, organizationId, status: { in: sourcesFor(to) } },
    data: {
      status: to,
      ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(isTerminal(to) ? { settledAt: new Date() } : {}),
    },
  })
  if (count === 0) return false

  // `running` is pure bookkeeping — nobody needs telling that a job started.
  if (to === 'running' || to === 'cancelled') return true

  await announce(input).catch((error) =>
    apiLogger.warn('agent request announcement failed', {
      requestId,
      status: to,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  return true
}

/** Absolute URL of the agent's portrait for Slack's icon_url. Null without an app origin. */
function portraitUrlFor(agent: { id: string; metadata: unknown }): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '')
  if (!base) return null
  const seed = avatarSeedFor({ id: agent.id, avatarSeed: readAgentMetadata(agent.metadata).avatarSeed })
  return `${base}${portraitFor(seed).src}`
}

const NOTIFY_COPY: Record<string, { type: string; level: 'success' | 'error' | 'info' | 'action'; verb: string }> = {
  completed: { type: 'agent.request.completed', level: 'success', verb: 'answered your request' },
  declined: { type: 'agent.request.declined', level: 'info', verb: "didn't take on your request" },
  failed: { type: 'agent.request.failed', level: 'error', verb: "couldn't finish your request" },
  waiting: { type: 'agent.request.waiting', level: 'action', verb: 'needs something from you' },
}

/** Tell the requester, in-app and — when the ask came from Slack — in-thread. */
async function announce(input: MoveAgentRequestInput): Promise<void> {
  const copy = NOTIFY_COPY[input.to]
  if (!copy) return

  const request = await prisma.agentRequest.findFirst({
    where: { id: input.requestId, organizationId: input.organizationId },
    select: {
      requestedByUserId: true,
      origin: true,
      originMeta: true,
      executionId: true,
      result: true,
      error: true,
      agentTask: { select: { id: true, description: true, metadata: true } },
    },
  })
  if (!request) return

  const agentName = agentDisplayName(request.agentTask)
  const body = input.to === 'completed' ? (request.result ?? undefined) : (input.question ?? request.error ?? undefined)

  await notify({
    organizationId: input.organizationId,
    userId: request.requestedByUserId,
    type: copy.type,
    level: copy.level,
    title: `${agentName} ${copy.verb}`,
    body,
    agentTaskId: request.agentTask.id,
    executionId: request.executionId ?? undefined,
  })

  if (request.origin !== 'slack') return
  const origin = slackOriginOf({ type: 'slack', slack: request.originMeta })
  if (!origin) return
  await deliverRequestSlackReply({
    organizationId: input.organizationId,
    origin,
    agentName,
    agentPortraitUrl: portraitUrlFor(request.agentTask),
    status: input.to as RequestReplyStatus,
    result: request.result,
    error: request.error,
    question: input.question,
    executionId: request.executionId,
  })
}
