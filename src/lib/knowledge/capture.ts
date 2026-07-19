import crypto from 'node:crypto'
import type { PersistedActivity } from '@/lib/activity/ledger'
import type { UsageProfile } from '@/lib/intelligence/connection-scan'
import { storeKnowledge } from './store'

function markdownJson(value: unknown): string {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return `\`\`\`json\n${body ?? 'null'}\n\`\`\``
}

export function captureAgentRunKnowledge(input: {
  organizationId: string
  userId: string
  agentId: string
  executionId: string
  agentTitle: string
  objective: string
  runInput: unknown
  output: unknown
}) {
  return storeKnowledge({
    organizationId: input.organizationId,
    userId: input.userId,
    agentId: input.agentId,
    sourceType: 'agent_run',
    sourceId: input.executionId,
    title: `${input.agentTitle} — completed run`,
    filename: `agent-runs/${input.agentId}/${input.executionId}.md`,
    visibility: 'private',
    content: [
      `# ${input.agentTitle} — completed run`,
      `\n## Objective\n${input.objective}`,
      `\n## Input\n${markdownJson(input.runInput)}`,
      `\n## Outcome\n${markdownJson(input.output)}`,
    ].join('\n'),
    provenance: { agentId: input.agentId, executionId: input.executionId, kind: 'agent-run' },
  })
}

export function captureFlowRunKnowledge(input: {
  organizationId: string
  userId: string
  flowId: string
  flowRunId: string
  flowName: string
  trigger: unknown
  runInput: unknown
  output: unknown
}) {
  return storeKnowledge({
    organizationId: input.organizationId,
    userId: input.userId,
    sourceType: 'flow_run',
    sourceId: input.flowRunId,
    title: `${input.flowName} — workflow outcome`,
    filename: `flow-runs/${input.flowId}/${input.flowRunId}.md`,
    visibility: 'private',
    content: [
      `# ${input.flowName} — workflow outcome`,
      `\n## Trigger\n${markdownJson(input.trigger)}`,
      `\n## Input\n${markdownJson(input.runInput)}`,
      `\n## Outcome\n${markdownJson(input.output)}`,
    ].join('\n'),
    provenance: { flowId: input.flowId, flowRunId: input.flowRunId, kind: 'flow-run' },
  })
}

export function captureConnectionProfileKnowledge(input: {
  organizationId: string
  userId: string | null
  plane: string
  connectionRef: string
  connectionName: string
  profile: UsageProfile
}) {
  const sourceId = `${input.plane}:${input.connectionRef}`
  return storeKnowledge({
    organizationId: input.organizationId,
    userId: input.userId,
    sourceType: 'connection_profile',
    sourceId,
    title: `How we use ${input.connectionName}`,
    filename: `connections/${sourceId.replace(/[^a-zA-Z0-9._-]/g, '-')}.md`,
    visibility: 'organization',
    content: [
      `# How we use ${input.connectionName}`,
      `\n${input.profile.summary}`,
      `\n## Business entities\n${input.profile.entities.map((item) => `- ${item}`).join('\n') || '- None observed'}`,
      `\n## Processes\n${input.profile.processes.map((item) => `- ${item}`).join('\n') || '- None observed'}`,
      `\n## Automation candidates\n${input.profile.automationCandidates.map((item) => `- ${item}`).join('\n') || '- None observed'}`,
    ].join('\n'),
    provenance: { plane: input.plane, connectionRef: input.connectionRef, connectionName: input.connectionName, kind: 'distilled-connection-profile' },
  })
}

/** Store one encrypted, searchable batch for every successful live/sync/backfill ingest. */
export function captureActivityKnowledge(organizationId: string, activities: PersistedActivity[]) {
  if (!activities.length) return Promise.resolve({ stored: false, reason: 'empty' })
  const ids = activities.map((activity) => activity.id)
  const sourceId = crypto.createHash('sha256').update(ids.join(':')).digest('hex')
  const sources = [...new Set(activities.map((activity) => activity.source))]
  return storeKnowledge({
    organizationId,
    sourceType: 'activity_sync',
    sourceId,
    title: `${sources.join(', ')} activity — ${activities.length} retained event${activities.length === 1 ? '' : 's'}`,
    filename: `activity/${sourceId}.md`,
    visibility: 'organization',
    content: activities.map((activity) => ({
      source: activity.source,
      action: activity.action,
      actor: { ref: activity.actorRef, name: activity.actorName },
      entity: { type: activity.entityType, ref: activity.entityRef, name: activity.entityName },
      previousState: activity.previousState,
      newState: activity.newState,
      participants: activity.participants,
      businessContext: activity.businessContext,
      outcome: activity.outcome,
      occurredAt: activity.occurredAt.toISOString(),
      ingestKind: activity.ingestKind,
    })),
    provenance: { activityEventIds: ids, sources, kind: 'normalized-activity-batch' },
  })
}
