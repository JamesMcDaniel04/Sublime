/** Pure Slack → flow routing: which of the org's slack-triggered flows does a
 * normalized event match? (kind ∈ events; command equality; channel allowlist;
 * keyword substring). Multiple matches all dispatch — each its own run. */
import { SLACK_EVENT_KINDS, type SlackEventKind, type SlackTriggerInput } from '@/lib/slack/payload'

export type SlackTriggerConfig = {
  type: 'slack'
  events: SlackEventKind[]
  /** Restrict this bot workflow to one verified workspace binding. */
  bindingId?: string
  command?: string
  channels?: string[]
  users?: string[]
  keyword?: string
  threadMemory?: boolean
}

export type SlackFlowCandidate = { id: string; trigger: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function slackTriggerConfigOf(trigger: unknown): SlackTriggerConfig | null {
  if (!isRecord(trigger) || trigger.type !== 'slack') return null
  const rawEvents = Array.isArray(trigger.events) ? trigger.events : []
  const events = rawEvents.filter(
    (kind): kind is SlackEventKind => typeof kind === 'string' && (SLACK_EVENT_KINDS as readonly string[]).includes(kind),
  )
  if (!events.length || events.length !== rawEvents.length) return null
  return {
    type: 'slack',
    events,
    ...(typeof trigger.bindingId === 'string' && trigger.bindingId.trim() ? { bindingId: trigger.bindingId.trim() } : {}),
    ...(typeof trigger.command === 'string' && trigger.command.trim() ? { command: trigger.command.trim() } : {}),
    ...(Array.isArray(trigger.channels) && trigger.channels.length
      ? { channels: trigger.channels.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
    ...(Array.isArray(trigger.users) && trigger.users.length
      ? { users: trigger.users.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
    ...(typeof trigger.keyword === 'string' && trigger.keyword.trim() ? { keyword: trigger.keyword.trim() } : {}),
    ...(trigger.threadMemory === true ? { threadMemory: true } : {}),
  }
}

const normalizeCommand = (command: string) => command.trim().toLowerCase().replace(/^\//, '')

export function matchSlackFlows(
  input: SlackTriggerInput,
  flows: SlackFlowCandidate[],
  bindingId?: string,
): { id: string; config: SlackTriggerConfig }[] {
  const matches: { id: string; config: SlackTriggerConfig }[] = []
  for (const candidate of flows) {
    const config = slackTriggerConfigOf(candidate.trigger)
    if (!config) continue
    if (config.bindingId && config.bindingId !== bindingId) continue
    if (!config.events.includes(input.kind)) continue
    if (input.kind === 'slash_command') {
      if (!config.command || !input.command) continue
      if (normalizeCommand(config.command) !== normalizeCommand(input.command)) continue
    }
    if (config.channels?.length && !config.channels.includes(input.channel)) continue
    if (config.users?.length && !config.users.includes(input.user)) continue
    if (config.keyword && !input.text.toLowerCase().includes(config.keyword.toLowerCase())) continue
    matches.push({ id: candidate.id, config })
  }
  return matches
}
