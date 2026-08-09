import type { AgentTask } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { assertAgentCapacity, assertSpecialistAreaCapacity } from '@/lib/billing/enforce'
import { departmentsForTools } from '@/lib/templates/departments'

/**
 * Draft→agent creation shared by POST /api/agents/draft and the Home
 * assistant. One home for the icon guard, schedule normalization, and
 * connector sync so the two entry points cannot drift.
 */

export type AgentDraft = {
  title: string
  icon: string
  description: string
  instructions: string
  integrations: string[]
  schedule: { type: string; time: string; cron: string; timezone: string; isActive: boolean }
}

export type NormalizedDraft = Omit<AgentDraft, 'schedule'> & {
  schedule: { type: string; timezone: string; isActive: boolean; time?: string; cron?: string }
  model: string
  visibility: 'private'
  folder: null
}

export function normalizeDraft(draft: AgentDraft): NormalizedDraft {
  const schedule = {
    type: draft.schedule.type,
    timezone: draft.schedule.timezone || 'UTC',
    isActive: draft.schedule.isActive && draft.schedule.type !== 'manual',
    ...(draft.schedule.time ? { time: draft.schedule.time } : {}),
    ...(draft.schedule.cron ? { cron: draft.schedule.cron } : {}),
  }
  // The model sometimes returns a word (e.g. "test") instead of an emoji for
  // `icon`; that then shows as broken text. Accept it only if it looks like an
  // emoji (no ASCII letters/digits, short), else fall back to a default mark.
  const rawIcon = draft.icon?.trim() || ''
  const icon = rawIcon && !/[A-Za-z0-9]/.test(rawIcon) && [...rawIcon].length <= 4 ? rawIcon : '🤖'
  return { ...draft, icon, schedule, model: DEFAULT_AGENT_MODEL, visibility: 'private', folder: null }
}

export async function createAgentFromDraft(
  draft: AgentDraft,
  ctx: { organizationId: string; userId: string },
): Promise<{ agent: AgentTask; draft: NormalizedDraft }> {
  const normalized = normalizeDraft(draft)
  const specialistArea = departmentsForTools(normalized.integrations)[0]
  await assertAgentCapacity(ctx.organizationId)
  await assertSpecialistAreaCapacity(ctx.organizationId, specialistArea)
  const agent = await prisma.agentTask.create({
    data: {
      agentType: 'CUSTOM',
      description: normalized.description || normalized.title,
      objective: normalized.instructions,
      schedule: normalized.schedule,
      status: 'ACTIVE',
      visibility: 'private',
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      metadata: {
        title: normalized.title,
        description: normalized.description,
        model: normalized.model,
        integrations: normalized.integrations,
        specialistArea,
        icon: normalized.icon,
      },
    },
  })
  // Typed connector bindings — without this, the agent's first run falls back
  // to metadata-string matching.
  await syncAgentConnectors(agent.id, ctx.organizationId, ctx.userId, normalized.integrations)
  return { agent, draft: normalized }
}
