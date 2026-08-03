/**
 * Run→goal contribution verdicts: the reflection pass's judgment of whether a
 * run actually advanced its linked goals, persisted per run per goal so the
 * disconnect between "runs finish cleanly" and "the metric doesn't move" is a
 * queryable fact instead of a vibe.
 *
 * Consumers: recovery-plan evidence (verdictEvidenceLine) and owner
 * escalation when an agent stalls on an at-risk goal. Escalation fires at
 * every THIRD consecutive non-advancing run rather than once per streak: a
 * modulo needs no dedup state, self-heals when the goal only turns at-risk
 * mid-streak, and re-nags at a bounded cadence instead of never or always.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import type { ContributionVerdict } from '@/features/agents/reflection'

const NON_ADVANCING = new Set(['no_change', 'counterproductive'])
export const STREAK_THRESHOLD = 3
/** Bound both goal fan-out and the prompt-side grounding to the same two. */
export const VERDICT_GOAL_BOUND = 2

export type VerdictRow = { verdict: string; runId: string }

/** Consecutive non-advancing runs, newest first. `unclear` breaks a streak
 *  without starting one — absence of evidence is not evidence of stalling. */
export function nonAdvancingStreak(newestFirst: VerdictRow[]): number {
  let streak = 0
  for (const row of newestFirst) {
    if (!NON_ADVANCING.has(row.verdict)) break
    streak += 1
  }
  return streak
}

export function shouldEscalateStreak(streak: number): boolean {
  return streak >= STREAK_THRESHOLD && streak % STREAK_THRESHOLD === 0
}

/** Recovery-plan evidence line; null when there is nothing worth saying —
 *  an all-advancing history would only dilute the measured-fact lines. */
export function verdictEvidenceLine(input: { total: number; nonAdvancing: number }): string | null {
  if (input.total === 0 || input.nonAdvancing === 0) return null
  return `${input.total} agent runs completed in the last 30 days; ${input.nonAdvancing} judged non-advancing by reflection.`
}

export type GoalStateForEscalation = {
  name: string
  status: string
  riskLevel: string
  ownerUserId: string | null
  createdByUserId: string | null
} | null

export type VerdictDeps = {
  linkedGoalIds: (organizationId: string, resource: { type: 'agent' | 'flow'; id: string }) => Promise<string[]>
  createVerdict: (row: {
    organizationId: string
    goalId: string
    resourceType: string
    resourceId: string
    runId: string
    verdict: string
    evidence: string
  }) => Promise<void>
  goalState: (goalId: string, organizationId: string) => Promise<GoalStateForEscalation>
  /** Newest first, for THIS resource on THIS goal. */
  recentVerdicts: (goalId: string, organizationId: string, resourceId: string, limit: number) => Promise<VerdictRow[]>
  escalate: (input: {
    organizationId: string
    goalId: string
    goalName: string
    resourceId: string
    ownerUserId: string
    streak: number
  }) => Promise<void>
}

const defaultDeps: VerdictDeps = {
  linkedGoalIds: async (organizationId, resource) => {
    const { resolveLinkedGoalIds } = await import('@/lib/integrations/goals-port')
    return resolveLinkedGoalIds(organizationId, resource)
  },
  createVerdict: async (row) => {
    await prisma.goalRunVerdict.create({ data: row })
  },
  goalState: (goalId, organizationId) =>
    prisma.goal.findFirst({
      where: { id: goalId, organizationId },
      select: { name: true, status: true, riskLevel: true, ownerUserId: true, createdByUserId: true },
    }),
  recentVerdicts: (goalId, organizationId, resourceId, limit) =>
    prisma.goalRunVerdict.findMany({
      where: { organizationId, goalId, resourceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { verdict: true, runId: true },
    }),
  escalate: async (input) => {
    const { notify } = await import('@/lib/notifications/service')
    await notify({
      organizationId: input.organizationId,
      userId: input.ownerUserId,
      type: 'goal.agent_stalled',
      level: 'action',
      title: `An agent has stopped advancing "${input.goalName}"`,
      body: `Its last ${input.streak} runs completed without advancing this at-risk goal. Retarget the agent's objective, or pause it if the work is no longer needed.`,
      agentTaskId: input.resourceId,
      link: `/goals/${input.goalId}`,
    })
  },
}

/**
 * Persist this run's contribution verdict against each linked goal (bounded)
 * and escalate stalls on at-risk goals. Fire-and-forget by callers; never
 * throws — a verdict hiccup must not fail a run that already succeeded.
 */
export async function recordGoalRunVerdicts(
  input: {
    organizationId: string
    resourceType: 'agent' | 'flow'
    resourceId: string
    runId: string
    verdict: ContributionVerdict
    evidence: string
    /** Exact ranked goals used to ground this run. Omit only when the caller
     *  did not resolve grounding, in which case the persistence layer falls
     *  back to the linked-goal query for compatibility. */
    goalIds?: string[]
  },
  deps: VerdictDeps = defaultDeps,
): Promise<void> {
  try {
    const goalIds = (input.goalIds ??
      (await deps.linkedGoalIds(input.organizationId, {
        type: input.resourceType,
        id: input.resourceId,
      })))
      .filter((goalId, index, all) => goalId && all.indexOf(goalId) === index)
      .slice(0, VERDICT_GOAL_BOUND)
    for (const goalId of goalIds) {
      await deps.createVerdict({
        organizationId: input.organizationId,
        goalId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        runId: input.runId,
        verdict: input.verdict,
        evidence: input.evidence.slice(0, 500),
      })
      if (!NON_ADVANCING.has(input.verdict)) continue
      const goal = await deps.goalState(goalId, input.organizationId)
      if (!goal || goal.status !== 'active') continue
      if (goal.riskLevel !== 'at_risk' && goal.riskLevel !== 'off_track') continue
      const recipient = goal.ownerUserId ?? goal.createdByUserId
      if (!recipient) continue
      const recent = await deps.recentVerdicts(goalId, input.organizationId, input.resourceId, STREAK_THRESHOLD * 2)
      const streak = nonAdvancingStreak(recent)
      if (shouldEscalateStreak(streak)) {
        await deps.escalate({
          organizationId: input.organizationId,
          goalId,
          goalName: goal.name,
          resourceId: input.resourceId,
          ownerUserId: recipient,
          streak,
        })
      }
    }
  } catch (error) {
    apiLogger.warn('goals.verdicts: record failed', {
      runId: input.runId,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
  }
}

export type FlowVerdictDeps = {
  linkedGoalIds: (organizationId: string, resource: { type: 'flow'; id: string }) => Promise<string[]>
  /** GoalWork rows this flow logged for this goal since the run started. */
  workCount: (goalId: string, organizationId: string, flowId: string, since: Date) => Promise<number>
  record: typeof recordGoalRunVerdicts
}

const defaultFlowDeps: FlowVerdictDeps = {
  linkedGoalIds: async (organizationId, resource) => {
    const { resolveLinkedGoalIds } = await import('@/lib/integrations/goals-port')
    return resolveLinkedGoalIds(organizationId, resource)
  },
  workCount: (goalId, organizationId, flowId, since) =>
    prisma.goalWork.count({
      where: {
        organizationId,
        goalId,
        resourceType: 'flow',
        resourceId: flowId,
        createdAt: { gte: since },
      },
    }),
  record: recordGoalRunVerdicts,
}

/**
 * Flow parity for verdicts. Flows have no reflection pass, so the verdict is
 * DETERMINISTIC, not judged: a run that logged goal work during its window
 * advanced the goal; a clean run that logged nothing is no_change. Keyed on
 * the run's time window because GoalWork rows carry resource provenance but
 * no per-run id. Per goal (work differs per goal), bounded by the same cap
 * as agent verdicts. Fire-and-forget; never throws.
 */
export async function recordFlowRunVerdicts(
  input: { organizationId: string; flowId: string; flowRunId: string; startedAt: Date },
  deps: FlowVerdictDeps = defaultFlowDeps,
): Promise<void> {
  try {
    const goalIds = (
      await deps.linkedGoalIds(input.organizationId, { type: 'flow', id: input.flowId })
    ).slice(0, VERDICT_GOAL_BOUND)
    for (const goalId of goalIds) {
      const count = await deps.workCount(goalId, input.organizationId, input.flowId, input.startedAt)
      const plural = count === 1 ? '' : 's'
      await deps.record({
        organizationId: input.organizationId,
        resourceType: 'flow',
        resourceId: input.flowId,
        runId: input.flowRunId,
        verdict: count > 0 ? 'advanced' : 'no_change',
        evidence:
          count > 0
            ? `Flow run logged ${count} work item${plural} toward this goal.`
            : 'Flow run completed without logging any work toward this goal.',
        goalIds: [goalId],
      })
    }
  } catch (error) {
    apiLogger.warn('goals.verdicts: flow record failed', {
      flowRunId: input.flowRunId,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
  }
}
