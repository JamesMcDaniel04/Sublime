/**
 * Reply-to-origin delivery for a Slack-originated AgentRequest.
 *
 * Deliberately NOT deliverSlackRunReply: that one is flow-shaped (it needs a
 * flowId, reads FlowRunStep rows to decide suppression, and its copy says
 * "the flow failed"). A request is a person asking an agent a question, so it
 * needs the agent's words and none of the flow machinery.
 *
 * Best-effort by contract — the caller catches. A Slack outage must never
 * change whether the request settled.
 */
import { systemPrisma } from '@/lib/prisma'
import { decryptSecretJson } from '@/lib/slack/connections'
import { postSlackMessage } from '@/lib/slack/post'
import type { SlackRunOrigin } from '@/lib/slack/reply'

/** Slack hard-limits a message; leave room for the trailing run link. */
const MAX_REPLY_CHARS = 2800

export type RequestReplyStatus = 'completed' | 'failed' | 'declined' | 'waiting'

/**
 * What the agent says back in the thread.
 *
 * A decline reads as the agent's own judgment ("that's outside what I do")
 * rather than an error, because it is one — the run worked exactly as
 * designed. Conflating the two would train people to treat a correct refusal
 * as a bug report.
 */
export function requestReplyText(args: {
  agentName: string
  status: RequestReplyStatus
  result?: string | null
  error?: string | null
  question?: string | null
  runUrl?: string | null
}): string | null {
  const tail = args.runUrl ? `\n\n<${args.runUrl}|View the run>` : ''
  switch (args.status) {
    case 'completed': {
      const body = args.result?.trim()
      if (!body) return `${args.agentName} finished, but produced no output.${tail}`
      return `${body.slice(0, MAX_REPLY_CHARS)}${body.length > MAX_REPLY_CHARS ? '…' : ''}${tail}`
    }
    case 'declined':
      return `${args.agentName} didn't take this on: ${args.error?.trim() || 'it falls outside what this agent does.'}`
    case 'failed':
      return `:warning: ${args.agentName} couldn't finish this${args.error ? `:\n> ${args.error.slice(0, 300)}` : '.'}${tail}`
    case 'waiting': {
      // Thread continuation for agent requests is not built yet (a
      // SlackThreadSession is keyed to a flow), so the answer has to be given
      // in the app. Say where explicitly rather than asking a question the
      // thread cannot receive an answer to.
      const ask = args.question?.trim() || `${args.agentName} needs something from you before it can continue.`
      return args.runUrl ? `${ask}\n\nAnswer in Sublime: ${args.runUrl}` : ask
    }
  }
}

export async function deliverRequestSlackReply(args: {
  organizationId: string
  origin: SlackRunOrigin
  agentName: string
  status: RequestReplyStatus
  result?: string | null
  error?: string | null
  question?: string | null
  executionId?: string | null
  fetchImpl?: typeof fetch
}): Promise<void> {
  // systemPrisma: post-run continuation of a session-less Slack request; the
  // binding lookup is still constrained to the request's own organizationId.
  const binding = await systemPrisma.slackWorkspaceConnection.findFirst({
    where: { id: args.origin.bindingId, organizationId: args.organizationId, status: 'active' },
  })
  if (!binding) return

  const base = process.env.NEXT_PUBLIC_APP_URL || ''
  const text = requestReplyText({
    agentName: args.agentName,
    status: args.status,
    result: args.result,
    error: args.error,
    question: args.question,
    // A decline needs no run link — there is nothing to inspect.
    runUrl: base && args.executionId && args.status !== 'declined' ? `${base}/agents?run=${args.executionId}` : null,
  })
  if (!text) return

  await postSlackMessage({
    botToken: decryptSecretJson(binding.botToken),
    channel: args.origin.channel,
    threadTs: args.origin.thread_ts,
    text,
    fetchImpl: args.fetchImpl,
  })
}
