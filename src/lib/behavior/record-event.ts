/**
 * In-app behavior capture (user behavior learning spec §1). Fire-and-forget:
 * a capture failure must never break the user action it records — errors are
 * swallowed, logged, and reported to Sentry (mirrors recordAudit).
 *
 * Privacy contract: `context` carries references and metadata only (resource
 * names, message ids, flags) — NEVER raw prompt/message content.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

export const USER_EVENT_KINDS = [
  'agent_run_manual', 'agent_created', 'agent_edited',
  'flow_created', 'flow_edited', 'flow_published', 'flow_run_manual',
  'copilot_prompt', 'assistant_prompt',
  'suggestion_accepted', 'suggestion_dismissed',
  'template_used', 'connection_added',
  'tool_call',
] as const

export type UserEventKind = (typeof USER_EVENT_KINDS)[number]

export interface UserEventInput {
  organizationId: string
  userId: string
  kind: UserEventKind
  resourceType?: string | null
  resourceId?: string | null
  /** References only (ids, names, flags) — never raw prompt/message content. */
  context?: Record<string, unknown>
}

export interface UserEventCreateData {
  organizationId: string
  userId: string
  kind: string
  resourceType: string | null
  resourceId: string | null
  context: Record<string, unknown>
}

/**
 * Deduped integration-usage capture (cross-tool spec §2): one `tool_call`
 * event per (execution, provider), regardless of how many calls the run made.
 * Callers accumulate provider → toolNames during a run and flush once.
 * Context carries references only (provider, tool names, execution id) —
 * never arguments or results. Fire-and-forget like recordUserEvent.
 */
export async function recordToolCallEvents(
  params: {
    organizationId: string
    userId: string
    executionId: string
    touched: ReadonlyMap<string, ReadonlySet<string>>
  },
  deps?: { record?: typeof recordUserEvent },
): Promise<void> {
  const record = deps?.record ?? recordUserEvent
  for (const [provider, toolNames] of params.touched) {
    if (!provider || toolNames.size === 0) continue
    await record({
      organizationId: params.organizationId,
      userId: params.userId,
      kind: 'tool_call',
      resourceType: 'integration',
      resourceId: provider,
      context: { provider, toolNames: [...toolNames].slice(0, 25), executionId: params.executionId },
    })
  }
}

export async function recordUserEvent(
  input: UserEventInput,
  deps?: { create?: (data: UserEventCreateData) => Promise<unknown> },
): Promise<void> {
  const create =
    deps?.create ?? ((data: UserEventCreateData) => prisma.userEvent.create({ data: { ...data, context: data.context as never } }))
  try {
    await create({
      organizationId: input.organizationId,
      userId: input.userId,
      kind: input.kind,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      context: input.context ?? {},
    })
  } catch (error) {
    apiLogger.warn('behavior.recordUserEvent failed', {
      kind: input.kind,
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { scope: 'behavior', kind: input.kind })
  }
}
