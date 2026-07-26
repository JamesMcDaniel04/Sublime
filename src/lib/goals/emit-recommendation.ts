/**
 * Risk-transition → recommendation. Called by the refresh tick only when a
 * goal transitions into at_risk/off_track; steady-state shortfall never
 * re-nags.
 *
 * Org goals emit a UserSuggestion addressed to the creator because
 * AgentMemory requires an agentId FK. They additionally notify org-wide.
 */
import { prisma } from '@/lib/prisma'
import { notify } from '@/lib/notifications/service'
import { loadTemplateAdoptionScores, sortByAdoption } from '@/lib/templates/adoption'
import { goalTemplatesFor } from '@/lib/templates/goal-fit'
import { SEED_CATALOGUE, type SeedTemplate } from '@/lib/templates/catalogue'
import type { Evaluation } from './evaluate'

export type EmitGoal = {
  id: string
  organizationId: string
  ownerUserId: string | null
  createdByUserId: string | null
  name: string
  kind: string
  unit: string
  targetValue: number
  targetDate: Date
  startAt: Date
  startValue: number
}

export type EmitDeps = {
  findOpen: (organizationId: string, goalId: string) => Promise<{ id: string } | null>
  createSuggestion: (data: Record<string, unknown>) => Promise<{ id: string }>
  notifyFn: typeof notify
  adoptionScores: typeof loadTemplateAdoptionScores
  seeds: SeedTemplate[]
}

const defaultDeps: EmitDeps = {
  findOpen: (organizationId, goalId) =>
    prisma.userSuggestion.findFirst({
      where: {
        organizationId,
        kind: 'goal_action',
        status: 'open',
        targetType: 'goal',
        targetId: goalId,
      },
      select: { id: true },
    }),
  createSuggestion: (data) =>
    prisma.userSuggestion.create({ data: data as never, select: { id: true } }),
  notifyFn: notify,
  adoptionScores: loadTemplateAdoptionScores,
  seeds: SEED_CATALOGUE,
}

function fmt(value: number, unit: string): string {
  if (unit === 'usd') return `$${Math.round(value).toLocaleString('en-US')}`
  if (unit === 'percent') return `${(value * 100).toFixed(1)}%`
  return Math.round(value).toLocaleString('en-US')
}

/** Rendered "why this exists" lines — measured facts only. */
export function renderGoalEvidence(input: {
  name: string
  unit: string
  currentValue: number | null
  targetValue: number
  expectedValue: number
  projectedValue: number | null
  targetDate: Date
}): string[] {
  const lines: string[] = []
  const deadline = input.targetDate.toISOString().slice(0, 10)
  if (input.currentValue !== null) {
    const gap = input.expectedValue - input.currentValue
    lines.push(
      `${input.name}: ${fmt(input.currentValue, input.unit)} is ${fmt(Math.abs(gap), input.unit)} behind pace (${fmt(input.expectedValue, input.unit)} expected by today).`,
    )
  }
  if (input.projectedValue !== null) {
    lines.push(
      `At the current rate you're projected to reach ${fmt(input.projectedValue, input.unit)} vs the ${fmt(input.targetValue, input.unit)} target by ${deadline}.`,
    )
  }
  return lines
}

export async function emitGoalRecommendation(
  goal: EmitGoal,
  evaluation: Evaluation,
  deps: EmitDeps = defaultDeps,
): Promise<{ emitted: boolean; reason?: string }> {
  if (await deps.findOpen(goal.organizationId, goal.id)) {
    return { emitted: false, reason: 'pending-suggestion' }
  }

  const recipient = goal.ownerUserId ?? goal.createdByUserId
  if (!recipient) return { emitted: false, reason: 'no-recipient' }

  const candidates = goalTemplatesFor(goal.kind, deps.seeds)
  const scores = await deps.adoptionScores()
  const [best] = sortByAdoption(candidates, (seed) => `seed:${seed.seedKey}`, scores)

  const expectedValue =
    goal.startValue + evaluation.expectedProgress * (goal.targetValue - goal.startValue)
  const evidence = renderGoalEvidence({
    name: goal.name,
    unit: goal.unit,
    currentValue: evaluation.currentValue,
    targetValue: goal.targetValue,
    expectedValue,
    projectedValue: evaluation.projectedValue,
    targetDate: goal.targetDate,
  })

  const title = `${goal.name} is ${evaluation.riskLevel === 'off_track' ? 'off track' : 'at risk'}`
  const description = best
    ? `Deploy "${best.name}" to help close the gap — ${best.description}`
    : `Review the goal's inputs and recent trend, and consider what automation could accelerate it. Sublime found no ready-made template for this goal kind yet.`

  const suggestion = await deps.createSuggestion({
    organizationId: goal.organizationId,
    userId: recipient,
    kind: 'goal_action',
    title,
    description,
    targetType: 'goal',
    targetId: goal.id,
    evidence,
    metadata: { goalId: goal.id, seedKey: best?.seedKey ?? null },
  })

  await deps.notifyFn({
    organizationId: goal.organizationId,
    ...(goal.ownerUserId ? { userId: goal.ownerUserId } : {}),
    type: 'goal.risk',
    level: 'action',
    title,
    body: evidence[0] ?? description,
    executionId: goal.id,
    link: `/goals/${goal.id}`,
  })

  return { emitted: true, reason: suggestion.id }
}
