/** Pure reply-to-origin decisions: origin parsing, reply text per terminal
 * status, and explicit-reply suppression. */
import { formatSlackReply } from '@/lib/slack/format'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'

export type SlackRunOrigin = {
  bindingId: string
  channel: string
  thread_ts?: string
  response_url?: string
  kind?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function slackOriginOf(trigger: unknown): SlackRunOrigin | null {
  if (!isRecord(trigger) || trigger.type !== 'slack' || !isRecord(trigger.slack)) return null
  const slack = trigger.slack
  if (typeof slack.bindingId !== 'string' || !slack.bindingId || typeof slack.channel !== 'string' || !slack.channel) return null
  return {
    bindingId: slack.bindingId,
    channel: slack.channel,
    ...(typeof slack.thread_ts === 'string' && slack.thread_ts ? { thread_ts: slack.thread_ts } : {}),
    ...(typeof slack.response_url === 'string' && slack.response_url ? { response_url: slack.response_url } : {}),
    ...(typeof slack.kind === 'string' ? { kind: slack.kind } : {}),
  }
}

export function resolveSlackReplyText(args: {
  status: 'succeeded' | 'failed' | 'waiting'
  output?: unknown
  error?: string | null
  question?: string
  runUrl?: string
}): string | null {
  if (args.status === 'succeeded') return formatSlackReply(args.output, { runUrl: args.runUrl })
  if (args.status === 'failed') {
    return `:warning: The flow failed${args.error ? `:\n> ${args.error.slice(0, 300)}` : '.'}`
  }
  return args.question?.trim() || 'The flow is waiting for your reply.'
}

/** True when this run already posted to the origin channel via an explicit
 * slack step (native:slack, or a nango plane whose ref names slack) — the
 * explicit reply wins for `succeeded`. Unresolvable/templated args → false
 * (the hook still posts; a duplicate reply beats silence). */
export function shouldSuppressSuccessReply(args: {
  steps: { nodeId: string; status: string; input?: unknown }[]
  nodesById: Map<string, { type: string; data?: Record<string, unknown> }>
  channel: string
}): boolean {
  for (const step of args.steps) {
    if (step.status !== 'succeeded') continue
    const node = args.nodesById.get(step.nodeId)
    if (node?.type !== 'tool') continue
    const connectionId = typeof node.data?.connectionId === 'string' ? node.data.connectionId : ''
    if (!connectionId) continue
    const { plane, ref } = parseFlowToolConnectionId(connectionId)
    const slackPlane = (plane === 'native' && ref === 'slack') || (plane === 'nango' && ref.toLowerCase().includes('slack'))
    if (!slackPlane) continue
    if (JSON.stringify(step.input ?? '').includes(args.channel)) return true
  }
  return false
}
