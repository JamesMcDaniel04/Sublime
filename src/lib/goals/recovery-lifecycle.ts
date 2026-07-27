/**
 * Recovery-plan lifecycle reconcile, run on every goal evaluation:
 * - a goal back on_track resolves its open plan (the strip disappears);
 * - connect_tool actions auto-complete once their source is actually
 *   connected (accepting only deep-links; the connection itself happens in
 *   /integrations, so completion is observed here, not claimed there).
 * Never throws — a lifecycle hiccup must not fail the evaluation tick.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { listMetricSourceOptions } from '@/lib/metrics/available-sources'
import {
  sourceIsAvailable,
  type MetricSourceOption,
} from '@/lib/metrics/source-options'

type LifecycleDeps = {
  findOpenPlanWithActions: (
    organizationId: string,
    goalId: string,
  ) => Promise<{
    id: string
    actions: Array<{ id: string; kind: string; status: string; payload: unknown }>
  } | null>
  resolvePlan: (id: string, organizationId: string) => Promise<void>
  completeAction: (id: string, organizationId: string) => Promise<void>
  listSources: (organizationId: string, userId: string) => Promise<MetricSourceOption[]>
  recipientFor: (goalId: string, organizationId: string) => Promise<string | null>
}

const defaultDeps: LifecycleDeps = {
  findOpenPlanWithActions: (organizationId, goalId) =>
    prisma.goalRecoveryPlan.findFirst({
      where: { organizationId, goalId, status: 'open' },
      select: {
        id: true,
        actions: {
          select: { id: true, kind: true, status: true, payload: true },
        },
      },
    }),
  resolvePlan: (id, organizationId) =>
    prisma.goalRecoveryPlan
      .update({
        where: { id, organizationId },
        data: { status: 'resolved', resolvedAt: new Date() },
      })
      .then(() => undefined),
  completeAction: (id, organizationId) =>
    prisma.goalRecoveryAction
      .update({ where: { id, organizationId }, data: { status: 'done' } })
      .then(() => undefined),
  listSources: (organizationId, userId) =>
    listMetricSourceOptions({ organizationId, dbUser: { id: userId } }),
  recipientFor: (goalId, organizationId) =>
    prisma.goal
      .findFirst({
        where: { id: goalId, organizationId },
        select: { ownerUserId: true, createdByUserId: true },
      })
      .then((goal) => goal?.ownerUserId ?? goal?.createdByUserId ?? null),
}

export async function reconcileRecoveryPlan(
  goalId: string,
  organizationId: string,
  riskLevel: string,
  deps: LifecycleDeps = defaultDeps,
): Promise<void> {
  try {
    const plan = await deps.findOpenPlanWithActions(organizationId, goalId)
    if (!plan) return

    if (riskLevel === 'on_track') {
      await deps.resolvePlan(plan.id, organizationId)
      return
    }

    const pending = plan.actions.filter(
      (action) =>
        action.kind === 'connect_tool' &&
        (action.status === 'proposed' || action.status === 'accepted'),
    )
    if (pending.length === 0) return
    const recipient = await deps.recipientFor(goalId, organizationId)
    if (!recipient) return
    const options = await deps.listSources(organizationId, recipient)
    const availableSources = new Set(
      options.filter((option) => sourceIsAvailable(option)).map((option) => option.source),
    )
    for (const action of pending) {
      const payload =
        action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
          ? (action.payload as Record<string, unknown>)
          : {}
      if (typeof payload.source === 'string' && availableSources.has(payload.source)) {
        await deps.completeAction(action.id, organizationId)
      }
    }
  } catch (error) {
    apiLogger.warn('goals.recovery: lifecycle reconcile failed', {
      goalId,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
  }
}
