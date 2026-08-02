/**
 * Risk-transition → recommendation. Called by the refresh tick only when a
 * goal transitions into at_risk/off_track; steady-state shortfall never
 * re-nags.
 *
 * The primary path drafts an AI recovery plan (diagnosis + selectable
 * actions, ids locked to pre-assembled candidates); the UserSuggestion it
 * emits is the alert vehicle pointing at the plan. Any drafting failure
 * falls back to the original rule-based single-template suggestion — AI is
 * an upgrade path, never a new failure mode.
 *
 * Org goals emit a UserSuggestion addressed to the creator because
 * AgentMemory requires an agentId FK. They additionally notify org-wide.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { notify } from '@/lib/notifications/service'
import { loadTemplateAdoptionScores, sortByAdoption } from '@/lib/templates/adoption'
import { goalTemplatesFor } from '@/lib/templates/goal-fit'
import { SEED_CATALOGUE, type SeedTemplate } from '@/lib/templates/catalogue'
import { listMetricSourceOptions } from '@/lib/metrics/available-sources'
import type { MetricSourceOption } from '@/lib/metrics/source-options'
import type { Evaluation } from './evaluate'
import { surfaceGoalBenchmark } from './aggregate-benchmarks'
import { GOAL_TEMPLATES } from './goal-templates'
import { assembleRecoveryCandidates } from './recovery-candidates'
import { draftRecoveryPlan, riskWorse } from './recovery'
import { verdictEvidenceLine } from './verdicts'

export type EmitGoal = {
  id: string
  organizationId: string
  ownerUserId: string | null
  createdByUserId: string | null
  name: string
  kind: string
  direction: string
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
  benchmark: (kind: string) => Promise<{
    orgCount: number
    settledCount: number
    achievedCount: number
    topSeedKeys: unknown
  } | null>
  findOpenPlan: (
    organizationId: string,
    goalId: string,
  ) => Promise<{ id: string; triggerRiskLevel: string } | null>
  supersedePlan: (id: string, organizationId: string) => Promise<void>
  createPlan: (data: {
    organizationId: string
    goalId: string
    triggerRiskLevel: string
    diagnosis: string
    evidence: string[]
    modelMeta: Record<string, unknown>
    actions: Array<{
      kind: string
      title: string
      rationale: string
      payload: Record<string, unknown>
      rank: number
    }>
  }) => Promise<{ id: string }>
  listSources: (organizationId: string, userId: string) => Promise<MetricSourceOption[]>
  draft: typeof draftRecoveryPlan
  goalTemplateSourcesFor: (kind: string) => string[]
  /** Reflection verdict counts over the last 30 days (lib/goals/verdicts.ts). */
  runVerdictCounts: (organizationId: string, goalId: string) => Promise<{ total: number; nonAdvancing: number }>
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
  benchmark: (kind) =>
    prisma.goalBenchmark.findUnique({
      where: { kind },
      select: {
        orgCount: true,
        settledCount: true,
        achievedCount: true,
        topSeedKeys: true,
      },
    }),
  findOpenPlan: (organizationId, goalId) =>
    prisma.goalRecoveryPlan.findFirst({
      where: { organizationId, goalId, status: 'open' },
      select: { id: true, triggerRiskLevel: true },
    }),
  supersedePlan: (id, organizationId) =>
    prisma.goalRecoveryPlan
      .update({ where: { id, organizationId }, data: { status: 'superseded' } })
      .then(() => undefined),
  createPlan: (data) =>
    prisma.goalRecoveryPlan.create({
      data: {
        organizationId: data.organizationId,
        goalId: data.goalId,
        triggerRiskLevel: data.triggerRiskLevel,
        diagnosis: data.diagnosis,
        evidence: data.evidence,
        modelMeta: data.modelMeta,
        actions: {
          create: data.actions.map((action) => ({
            ...action,
            organizationId: data.organizationId,
          })),
        },
      },
      select: { id: true },
    }),
  listSources: (organizationId, userId) =>
    listMetricSourceOptions({ organizationId, dbUser: { id: userId } }),
  draft: draftRecoveryPlan,
  goalTemplateSourcesFor: (kind) =>
    GOAL_TEMPLATES.find((template) => template.kind === kind)?.sources ?? [],
  runVerdictCounts: async (organizationId, goalId) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const [total, nonAdvancing] = await Promise.all([
      prisma.goalRunVerdict.count({ where: { organizationId, goalId, createdAt: { gte: since } } }),
      prisma.goalRunVerdict.count({
        where: { organizationId, goalId, createdAt: { gte: since }, verdict: { in: ['no_change', 'counterproductive'] } },
      }),
    ])
    return { total, nonAdvancing }
  },
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
  // Plan-level gate: an open plan mutes re-emission UNLESS the risk got
  // strictly worse — then the stale plan is superseded and regenerated.
  const openPlan = await deps.findOpenPlan(goal.organizationId, goal.id)
  if (openPlan && !riskWorse(evaluation.riskLevel, openPlan.triggerRiskLevel)) {
    return { emitted: false, reason: 'open-plan' }
  }

  const recipient = goal.ownerUserId ?? goal.createdByUserId
  if (!recipient) return { emitted: false, reason: 'no-recipient' }

  const benchmarkRow = await deps.benchmark(goal.kind)
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
  const benchmark = surfaceGoalBenchmark(benchmarkRow)
  if (benchmark) {
    evidence.push(
      `Across ${benchmark.orgCount} teams tracking this kind of goal, ${benchmark.achievedRate}% hit their last target.`,
    )
  }
  // Run→goal disconnect: agents completing runs that reflection judged
  // non-advancing is exactly the evidence a recovery diagnosis needs to stop
  // recommending "launch more agents". Best-effort — a verdict-store failure
  // must not block the alert.
  try {
    const line = verdictEvidenceLine(await deps.runVerdictCounts(goal.organizationId, goal.id))
    if (line) evidence.push(line)
  } catch {
    // Evidence enrichment only.
  }

  const title = `${goal.name} is ${evaluation.riskLevel === 'off_track' ? 'off track' : 'at risk'}`
  const emitSuggestionAndNotify = async (
    description: string,
    metadata: Record<string, unknown>,
  ) => {
    const suggestion = await deps.createSuggestion({
      organizationId: goal.organizationId,
      userId: recipient,
      kind: 'goal_action',
      title,
      description,
      targetType: 'goal',
      targetId: goal.id,
      evidence,
      metadata,
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
    return suggestion
  }

  try {
    const [sources, scores] = await Promise.all([
      deps.listSources(goal.organizationId, recipient),
      deps.adoptionScores(),
    ])
    const candidates = assembleRecoveryCandidates({
      goalKind: goal.kind,
      seeds: deps.seeds,
      adoptionScores: scores,
      sources,
      goalTemplateSources: deps.goalTemplateSourcesFor(goal.kind),
    })
    const started = Date.now()
    const draft = await deps.draft({ goal, evidence, candidates })
    if (openPlan) await deps.supersedePlan(openPlan.id, goal.organizationId)
    const plan = await deps.createPlan({
      organizationId: goal.organizationId,
      goalId: goal.id,
      triggerRiskLevel: evaluation.riskLevel,
      diagnosis: draft.diagnosis,
      evidence,
      modelMeta: { ms: Date.now() - started },
      actions: draft.actions.map((action, rank) => {
        let payload: Record<string, unknown> = {}
        if (action.kind === 'connect_tool') payload = { source: action.refId }
        if (action.kind === 'launch_agent') payload = { seedKey: action.refId }
        return {
          kind: action.kind,
          title: action.title,
          rationale: action.rationale,
          rank,
          payload,
        }
      }),
    })
    const suggestion = await emitSuggestionAndNotify(draft.diagnosis, {
      goalId: goal.id,
      planId: plan.id,
      seedKey: null,
    })
    return { emitted: true, reason: suggestion.id }
  } catch (error) {
    apiLogger.warn('goals.recovery: draft failed, using rule-based fallback', {
      goalId: goal.id,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
  }

  // Legacy rule-based fallback: the suggestion-level dedup gate applies here
  // only — the plan path replaces (supersedes) rather than dedupes.
  if (await deps.findOpen(goal.organizationId, goal.id)) {
    return { emitted: false, reason: 'pending-suggestion' }
  }
  const candidates = goalTemplatesFor(goal.kind, deps.seeds)
  const scores = await deps.adoptionScores()
  const [best] = sortByAdoption(candidates, (seed) => `seed:${seed.seedKey}`, scores)
  const description = best
    ? `Deploy "${best.name}" to help close the gap — ${best.description}`
    : `Review the goal's inputs and recent trend, and consider what automation could accelerate it. Sublime found no ready-made template for this goal kind yet.`
  const suggestion = await emitSuggestionAndNotify(description, {
    goalId: goal.id,
    seedKey: best?.seedKey ?? null,
  })
  return { emitted: true, reason: suggestion.id }
}
