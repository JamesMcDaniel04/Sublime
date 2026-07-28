/**
 * Component binding for an EXISTING goal (spec 2026-07-28 §6, which requires
 * binding in the wizard *and* goal edit).
 *
 * A whole-set replace rather than per-slot mutations, for the same reason
 * dashboardLayout is replaced wholesale: the composition is only valid as a
 * set, so validating and swapping it in one transaction is the only way a
 * half-applied edit cannot leave a goal permanently gated. The goal is
 * re-evaluated in the same request so compositionState never lags the binding
 * that produced it.
 */
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { evaluateAndPersistGoal } from '@/lib/goals/refresh'
import { validateReadOnlyQuery } from '@/lib/metrics/sources/postgres'
import { assertSafeUrl } from '@/lib/metrics/sources/url'
import { NO_CONNECTION_SOURCES } from '@/lib/goals/metric-sources'
import { validateComposition } from '@/lib/goals/composition'
import type { GoalKind } from '@/lib/goals/kind-migration'

export const runtime = 'nodejs'

/** Matches the create route's cap: one headline plus its components. */
const MAX_COMPONENTS = 11

const componentSchema = z.object({
  slot: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  source: z.string().min(1),
  metricKey: z.string().min(1),
  connectionRef: z.string().nullable().optional(),
  unit: z.enum(['usd', 'count', 'percent']).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})

const bodySchema = z
  .object({
    composition: z.unknown().optional(),
    components: z.array(componentSchema).max(MAX_COMPONENTS).default([]),
  })
  .refine(
    (body) =>
      body.components.every(
        (component) =>
          NO_CONNECTION_SOURCES.has(component.source) ||
          Boolean(component.connectionRef),
      ),
    { message: 'Pick the connection each driver reads from.' },
  )
  // Same per-source checks as creation: a bad query or URL must fail here
  // rather than surface as lastError on the first tick.
  .superRefine((body, ctx) => {
    for (const [index, component] of body.components.entries()) {
      const issue = (path: string, message: string) =>
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['components', index, 'config', path],
          message,
        })
      if (component.source === 'postgres') {
        try {
          validateReadOnlyQuery(
            typeof component.config.query === 'string' ? component.config.query : '',
          )
        } catch (error) {
          issue('query', error instanceof Error ? error.message : 'Invalid query.')
        }
      }
      if (component.source === 'url') {
        try {
          assertSafeUrl(
            typeof component.config.url === 'string' ? component.config.url : '',
          )
        } catch (error) {
          issue('url', error instanceof Error ? error.message : 'Invalid URL.')
        }
      }
    }
  })

const idFrom = (pathname: string) =>
  decodeURIComponent(pathname.split('/').at(-2) ?? '')

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const input = bodySchema.parse(await request.json().catch(() => ({})))

  const goal = await prisma.goal.findFirst({
    where: {
      id,
      organizationId: auth.organizationId,
      // Same visibility rule as the detail route: another user's personal goal
      // is not editable, and must not even be discoverable.
      OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }],
    },
    select: { id: true, kind: true, unit: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')

  const slots = input.components.map((component) => component.slot)
  const message = validateComposition(
    goal.kind as GoalKind,
    input.composition ?? null,
    slots,
  )
  if (message) throw new ApiError(message, 400, 'INVALID_COMPOSITION')

  await prisma.$transaction(async (tx) => {
    // Replace the set: components absent from the request are unbound, which
    // cascades their datapoints. That is the intent — an unbound driver has no
    // readings to keep — and the dialog says so before saving.
    await tx.goalMetric.deleteMany({
      where: {
        organizationId: auth.organizationId,
        goalId: goal.id,
        role: 'component',
        ...(slots.length > 0 ? { slot: { notIn: slots } } : {}),
      },
    })
    for (const component of input.components) {
      const data = {
        label: component.label,
        source: component.source,
        metricKey: component.metricKey,
        connectionRef: NO_CONNECTION_SOURCES.has(component.source)
          ? null
          : (component.connectionRef ?? null),
        unit: component.unit ?? null,
        config: component.config as never,
        // Rebinding a slot to a different source invalidates its old readings,
        // and lastError must not outlive the binding that caused it.
        lastError: null,
      }
      const existing = await tx.goalMetric.findFirst({
        where: {
          organizationId: auth.organizationId,
          goalId: goal.id,
          slot: component.slot,
        },
        select: { id: true, source: true, metricKey: true },
      })
      if (!existing) {
        await tx.goalMetric.create({
          data: {
            organizationId: auth.organizationId,
            goalId: goal.id,
            role: 'component',
            slot: component.slot,
            ...data,
          },
        })
        continue
      }
      const rebound =
        existing.source !== component.source ||
        existing.metricKey !== component.metricKey
      if (rebound) {
        await tx.metricDatapoint.deleteMany({
          where: {
            organizationId: auth.organizationId,
            goalMetricId: existing.id,
          },
        })
      }
      await tx.goalMetric.update({
        where: { id: existing.id, organizationId: auth.organizationId },
        data,
      })
    }
    await tx.goal.update({
      where: { id: goal.id, organizationId: auth.organizationId },
      data: { composition: (input.composition ?? null) as never },
    })
  })

  // Re-evaluate in the same request so the strip and the list badge reflect the
  // binding immediately rather than at the next cron tick.
  await evaluateAndPersistGoal(goal.id, auth.organizationId)

  const saved = await prisma.goal.findFirst({
    where: { id: goal.id, organizationId: auth.organizationId },
    select: { compositionState: true, riskLevel: true },
  })
  return {
    success: true,
    compositionState: saved?.compositionState ?? null,
    riskLevel: saved?.riskLevel ?? null,
  }
})
