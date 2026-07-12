/** Post-run reply-to-origin delivery: called by runFlowExecution after the
 * run's terminal/waiting status is persisted. Best-effort by contract — the
 * caller catches; a Slack outage must never affect the run's outcome. */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { flowGraphSchema } from '@/lib/flows/graph'
import { decryptSecretJson } from '@/lib/slack/connections'
import { postSlackMessage, postSlackResponseUrl } from '@/lib/slack/post'
import { resolveSlackReplyText, shouldSuppressSuccessReply, type SlackRunOrigin } from '@/lib/slack/reply'
import { recordSessionAgentExecution } from '@/lib/slack/session'

export async function deliverSlackRunReply(args: {
  organizationId: string
  flowId: string
  flowRunId: string
  status: 'succeeded' | 'failed' | 'waiting'
  output: unknown
  error?: string | null
  question?: string
  origin: SlackRunOrigin
  fetchImpl?: typeof fetch
}): Promise<void> {
  const { origin } = args

  // Session upkeep: remember the run's LAST agent execution as the thread's
  // conversation seed (no-op when the run has no open session or agent
  // steps). Runs regardless of the suppression/reply logic below, so a
  // suppressed reply still keeps the conversation seed current.
  // status: 'succeeded' — a FAILED last agent step may end on a dangling
  // tool_use with no matching tool result; seeding the next thread reply from
  // it would hand the model a malformed transcript. Only a cleanly-settled
  // step may become the session's conversation seed.
  const lastAgentStep = await systemPrisma.flowRunStep.findFirst({
    where: { flowRunId: args.flowRunId, agentExecutionId: { not: null }, status: 'succeeded' },
    orderBy: { order: 'desc' },
    select: { agentExecutionId: true },
  })
  await recordSessionAgentExecution({
    organizationId: args.organizationId,
    flowRunId: args.flowRunId,
    agentExecutionId: lastAgentStep?.agentExecutionId ?? null,
  }).catch(() => undefined)

  // systemPrisma: post-run continuation of a session-less slack run; the
  // binding is still constrained to the run's own organizationId.
  const binding = await systemPrisma.slackWorkspaceConnection.findFirst({
    where: { id: origin.bindingId, organizationId: args.organizationId, status: 'active' },
  })
  if (!binding) return

  // Suppression: if an explicit slack step in this run already posted to the
  // origin channel, stay silent for `succeeded` — questions/failures still post.
  if (args.status === 'succeeded') {
    const run = await systemPrisma.flowRun.findFirst({
      where: { id: args.flowRunId, organizationId: args.organizationId },
      select: { graphSnapshot: true },
    })
    const steps = await systemPrisma.flowRunStep.findMany({
      where: { flowRunId: args.flowRunId },
      select: { nodeId: true, status: true, input: true },
    })
    const parsed = run?.graphSnapshot ? flowGraphSchema.safeParse(run.graphSnapshot) : null
    if (parsed?.success) {
      const nodesById = new Map(parsed.data.nodes.map((node) => [node.id, node as { type: string; data?: Record<string, unknown> }]))
      if (shouldSuppressSuccessReply({ steps, nodesById, channel: origin.channel })) return
    }
  }

  const runUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/flows/${args.flowId}/activity`
  const text = resolveSlackReplyText({ status: args.status, output: args.output, error: args.error, question: args.question, runUrl })
  if (!text) return

  const botToken = decryptSecretJson(binding.botToken)
  // Slash commands reply via response_url (30-min validity); anything else —
  // and a failed response_url post — goes to the channel, always in-thread.
  if (origin.response_url && origin.kind === 'slash_command') {
    try {
      await postSlackResponseUrl({ responseUrl: origin.response_url, text, fetchImpl: args.fetchImpl })
      return
    } catch (error) {
      apiLogger.warn('slack response_url reply failed — falling back to chat.postMessage', {
        flowRunId: args.flowRunId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  await postSlackMessage({ botToken, channel: origin.channel, threadTs: origin.thread_ts, text, fetchImpl: args.fetchImpl })
}
