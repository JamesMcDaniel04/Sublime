/**
 * Recovery-plan drafting: one structured model call that SELECTS from
 * pre-assembled candidates. Ids are re-validated post-hoc; an id the
 * assembler didn't offer is dropped, and an empty surviving set is a
 * failure — the caller falls back to the rule-based suggestion.
 */
import { z } from 'zod'
import { generateStructured } from '@/lib/llm/model-runner'
import type { RecoveryCandidates } from './recovery-candidates'

export class RecoveryDraftError extends Error {}

const RISK_SEVERITY: Record<string, number> = { at_risk: 1, off_track: 2 }

/** Is `next` a strictly worse risk level than `prev`? Drives supersede-and-
 * regenerate: an open at_risk plan is replaced when the goal slips to
 * off_track, but same-level flapping never regenerates. */
export function riskWorse(next: string, prev: string): boolean {
  return (RISK_SEVERITY[next] ?? 0) > (RISK_SEVERITY[prev] ?? 0)
}

/** Strict-subset nullable — same constraint as COPILOT_DRAFT_SCHEMA. */
const nullable = (schema: Record<string, unknown>) =>
  ({ anyOf: [schema, { type: 'null' }] }) as const

export const RECOVERY_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    diagnosis: {
      type: 'string',
      description:
        'Why the goal is behind, grounded ONLY in the evidence lines provided. 1-3 sentences.',
    },
    // 2-5 actions; count is enforced by rawPlanSchema + the system prompt —
    // minItems/maxItems are outside the supported strict subset.
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['connect_tool', 'launch_agent', 'manual_step'] },
          refId: nullable({
            type: 'string',
            description:
              'connect_tool: a source id from sourceGaps. launch_agent: a seedKey from agentTemplates. manual_step: null.',
          }),
          title: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['kind', 'refId', 'title', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['diagnosis', 'actions'],
  additionalProperties: false,
} as const

const rawPlanSchema = z.object({
  diagnosis: z.string().min(1).max(1000),
  actions: z
    .array(
      z.object({
        kind: z.enum(['connect_tool', 'launch_agent', 'manual_step']),
        refId: z.string().nullable(),
        title: z.string().min(1).max(120),
        rationale: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(5),
})

export type RecoveryActionDraft = {
  kind: 'connect_tool' | 'launch_agent' | 'manual_step'
  refId: string | null
  title: string
  rationale: string
}
export type RecoveryPlanDraft = { diagnosis: string; actions: RecoveryActionDraft[] }

export function validateRecoveryDraft(
  raw: string,
  candidates: RecoveryCandidates,
): RecoveryPlanDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RecoveryDraftError('unparseable recovery draft')
  }
  const shell = rawPlanSchema.safeParse(parsed)
  if (!shell.success) throw new RecoveryDraftError('recovery draft failed shape validation')

  const gapSources = new Set(candidates.sourceGaps.map((gap) => gap.source))
  const seedKeys = new Set(candidates.agentTemplates.map((template) => template.seedKey))
  const actions = shell.data.actions.filter((action) =>
    action.kind === 'manual_step'
      ? true
      : action.kind === 'connect_tool'
        ? action.refId !== null && gapSources.has(action.refId)
        : action.refId !== null && seedKeys.has(action.refId),
  )
  if (actions.length === 0) {
    throw new RecoveryDraftError('no valid actions survived id validation')
  }
  return { diagnosis: shell.data.diagnosis, actions }
}

const SYSTEM = [
  'A measurable business goal has fallen behind pace. Write a short recovery plan.',
  'Rules:',
  '- diagnosis: 1-3 sentences explaining the shortfall using ONLY the evidence lines given. Never invent numbers.',
  '- 2 to 5 actions, most impactful first.',
  '- connect_tool actions: refId MUST be one of the sourceGaps ids. Recommending a connection means exact automatic tracking replaces manual/assisted entry.',
  '- launch_agent actions: refId MUST be a seedKey from agentTemplates. These are automations that do work toward the goal.',
  '- manual_step actions: refId null; a concrete step the human should take. Use sparingly — prefer tools and agents.',
  '- title: short imperative. rationale: one sentence tying the action to the evidence.',
  '- Respond with the JSON object only.',
].join('\n')

export async function draftRecoveryPlan(input: {
  goal: {
    name: string
    kind: string
    unit: string
    targetValue: number
    targetDate: Date
    direction: string
  }
  evidence: string[]
  candidates: RecoveryCandidates
  generate?: typeof generateStructured
}): Promise<RecoveryPlanDraft> {
  const generate = input.generate ?? generateStructured
  const user = JSON.stringify({
    goal: {
      name: input.goal.name,
      kind: input.goal.kind,
      unit: input.goal.unit,
      targetValue: input.goal.targetValue,
      targetDate: input.goal.targetDate.toISOString().slice(0, 10),
      direction: input.goal.direction,
    },
    evidence: input.evidence,
    agentTemplates: input.candidates.agentTemplates,
    sourceGaps: input.candidates.sourceGaps,
  })
  let raw: string
  try {
    raw = await generate({
      system: SYSTEM,
      user,
      schema: RECOVERY_PLAN_SCHEMA as unknown as Record<string, unknown>,
      schemaName: 'goal_recovery_plan',
      maxTokens: 1500,
    })
  } catch (error) {
    throw new RecoveryDraftError(
      error instanceof Error ? error.message : 'recovery draft generation failed',
    )
  }
  return validateRecoveryDraft(raw, input.candidates)
}
