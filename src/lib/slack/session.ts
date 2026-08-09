/** SlackThreadSession: one Slack thread ↔ one flow conversation.
 * resolveSessionRouting is the pure precedence decision the ingress applies
 * BEFORE trigger matching; the DB helpers wrap the session lifecycle. */
import { Prisma } from '@/generated/prisma/client'
import { systemPrisma } from '@/lib/prisma'

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export type SessionRouting =
  | { mode: 'resume'; flowRunId: string; flowId: string }
  | { mode: 'continue'; flowId: string; continueExecutionId?: string }
  | { mode: 'fallthrough' }

export function resolveSessionRouting(args: {
  session: { flowId: string; flowRunId: string; agentExecutionId: string | null; status: string } | null
  runStatus: string | null
  flowActive: boolean
}): SessionRouting {
  const { session } = args
  if (!session || session.status !== 'open') return { mode: 'fallthrough' }
  if (!args.flowActive) return { mode: 'fallthrough' }
  if (args.runStatus === 'waiting') return { mode: 'resume', flowRunId: session.flowRunId, flowId: session.flowId }
  return {
    mode: 'continue',
    flowId: session.flowId,
    ...(session.agentExecutionId ? { continueExecutionId: session.agentExecutionId } : {}),
  }
}

// systemPrisma throughout: these run in the session-less ingress/post-run
// continuations; every query is scoped to the caller's organizationId.

export async function findOpenSession(args: { organizationId: string; bindingId: string; channel: string; threadTs: string }) {
  return systemPrisma.slackThreadSession.findFirst({
    where: { organizationId: args.organizationId, bindingId: args.bindingId, channel: args.channel, threadTs: args.threadTs, status: 'open' },
  })
}

/**
 * First-flow-wins: one conversation per thread. `SlackThreadSession` is
 * `@@unique([bindingId, channel, threadTs])` — one row per thread — so if two
 * `threadMemory:true` flows both match the same event, a plain upsert would
 * let the SECOND flow's dispatch overwrite the FIRST flow's row, stranding
 * any `waiting` run it had and mis-routing later thread replies to the wrong
 * flow. Instead: create the row if none exists for this thread; if one
 * already exists for a DIFFERENT flowId, leave it alone (the incumbent flow
 * keeps the thread — the other flow still ran its one-shot, it just never
 * owns the thread's memory). Only refresh the run/agentExecution pointers
 * when the existing row's flowId already matches.
 *
 * Atomicity: a prior findUnique-then-upsert was check-then-act — two
 * concurrent calls for the same brand-new thread could both miss the
 * findUnique and race the upsert, letting the second's update stomp the
 * first's flowId/flowRunId. Instead attempt `create` FIRST: the
 * `@@unique([bindingId, channel, threadTs])` constraint makes only one
 * concurrent create succeed, so the DB — not a read-then-write — decides the
 * winner. The loser catches P2002, re-reads the now-existing row, and
 * applies the same "same flow refreshes, different flow leaves it alone"
 * rule against what actually landed.
 */
export async function upsertThreadSession(args: {
  organizationId: string
  bindingId: string
  channel: string
  threadTs: string
  flowId: string
  flowRunId: string
}): Promise<void> {
  try {
    await systemPrisma.slackThreadSession.create({ data: { ...args, status: 'open' } })
    return
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
  const existing = await systemPrisma.slackThreadSession.findUnique({
    where: { bindingId_channel_threadTs: { bindingId: args.bindingId, channel: args.channel, threadTs: args.threadTs } },
    select: { flowId: true },
  })
  if (existing?.flowId !== args.flowId) return
  await systemPrisma.slackThreadSession.updateMany({
    where: { bindingId: args.bindingId, channel: args.channel, threadTs: args.threadTs, flowId: args.flowId },
    data: { flowId: args.flowId, flowRunId: args.flowRunId, status: 'open' },
  })
}

/** Post-run: remember the run's last agent execution as the thread's
 * conversation seed. No-op when the run has no session or no agent steps. */
export async function recordSessionAgentExecution(args: {
  organizationId: string
  flowRunId: string
  agentExecutionId: string | null
}): Promise<void> {
  if (!args.agentExecutionId) return
  await systemPrisma.slackThreadSession.updateMany({
    where: { organizationId: args.organizationId, flowRunId: args.flowRunId, status: 'open' },
    data: { agentExecutionId: args.agentExecutionId },
  })
}

export async function closeSession(args: { organizationId: string; id: string }): Promise<void> {
  await systemPrisma.slackThreadSession.updateMany({
    where: { organizationId: args.organizationId, id: args.id },
    data: { status: 'closed' },
  })
}

/** Cron sweep: close sessions idle for 7+ days (all orgs — CRON_SECRET-gated caller). */
export async function closeStaleSlackSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const result = await systemPrisma.slackThreadSession.updateMany({
    where: { status: 'open', updatedAt: { lt: cutoff } },
    data: { status: 'closed' },
  })
  return result.count
}
