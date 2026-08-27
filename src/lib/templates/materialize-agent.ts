/**
 * Create one ACTIVE, runnable AgentTask from a spec — the single path a
 * template, an imported recipe, or a store listing takes onto the roster.
 * Extracted from the provision route so the store's native install is not a
 * fourth agent-creation path drifting from the other three.
 */
import { prisma } from '@/lib/prisma'
import { provisionedGrants } from '@/lib/agents/grants'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import type { AgentSchedule } from '@/lib/scheduling/due'
import { withTemplateOutputStandard } from '@/lib/templates/output-standard'
import { assertAgentCapacity, assertSpecialistAreaCapacity } from '@/lib/billing/enforce'
import { departmentsForTools } from '@/lib/templates/departments'

export const MANUAL_SCHEDULE: AgentSchedule = {
  type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false,
}

export type MaterializeSpec = {
  title: string
  instructions: string
  model?: string
  integrations: string[]
  requiredIntegrations?: string[]
  description?: string
  /** Extra agent metadata (skills, goal, output fields…) carried by
   *  DB-authored templates; seeds leave it empty. */
  extraMetadata?: Record<string, unknown>
  /** Roster identity to file this agent under, so a template joins an existing
   *  avatar instead of standing up a new one. */
  workerId?: string | null
}

/** Create one AgentTask mirroring POST /api/agents' create shape (an ACTIVE, runnable agent). */
export async function materializeAgent(
  spec: MaterializeSpec,
  organizationId: string,
  userId: string,
  schedule: AgentSchedule = MANUAL_SCHEDULE,
  specialistArea = departmentsForTools(spec.integrations)[0],
): Promise<string> {
  await assertAgentCapacity(organizationId)
  await assertSpecialistAreaCapacity(organizationId, specialistArea)
  // Preserve the catalogue description a user saw on the template card; fall
  // back to the title only when the spec carries none (embedded flow specs).
  const description = spec.description?.trim() || spec.title
  const agent = await prisma.agentTask.create({
    data: {
      agentType: 'CUSTOM',
      description,
      objective: withTemplateOutputStandard(spec.instructions),
      ...(spec.workerId ? { workerId: spec.workerId } : {}),
      schedule,
      status: 'ACTIVE',
      visibility: 'private',
      organizationId,
      userId,
      // Write on the planes the template declared, read on everything else.
      grants: provisionedGrants(spec.integrations),
      metadata: {
        title: spec.title,
        description,
        model: spec.model ?? DEFAULT_AGENT_MODEL,
        integrations: spec.integrations,
        specialistArea,
        requiredIntegrations: spec.requiredIntegrations ?? [],
        skills: [],
        icon: '',
        allowSubagents: false,
        subagentIds: [],
        autoAnswerFromMemory: true,
        ...(spec.extraMetadata ?? {}),
      },
    },
    select: { id: true },
  })
  return agent.id
}
