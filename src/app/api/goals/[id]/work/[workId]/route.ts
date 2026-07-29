import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  DISPOSITIONS,
  OUTCOMES,
  refusePatch,
  type Disposition,
  type Outcome,
} from '@/lib/goals/work-transitions'

export const runtime = 'nodejs'

const patchSchema = z
  .object({
    disposition: z.enum(DISPOSITIONS).optional(),
    outcome: z.enum(OUTCOMES).optional(),
    outcomeNote: z.string().max(2000).nullable().optional(),
    // A cuid, not a uuid — User.id is cuid-shaped. `.uuid()` here would reject
    // every real assignment.
    assigneeUserId: z.string().min(1).max(64).nullable().optional(),
    body: z.string().max(50_000).optional(),
    skipReason: z.string().max(500).nullable().optional(),
    skipNote: z.string().max(2000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change')

/** pathname: /api/goals/<goalId>/work/<workId> */
const idsFrom = (pathname: string) => {
  const segments = pathname.split('/')
  return {
    workId: decodeURIComponent(segments.at(-1) ?? ''),
    goalId: decodeURIComponent(segments.at(-3) ?? ''),
  }
}

/**
 * Apply a human's decision to one work item.
 *
 * Legality lives in refusePatch, not here, so the rules are unit-testable and
 * the UI can share them. The one that matters: an outcome may only land on
 * work someone actually used.
 */
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const { goalId, workId } = idsFrom(request.nextUrl.pathname)
  const patch = patchSchema.parse(await request.json())

  const current = await prisma.goalWork.findFirst({
    where: { id: workId, goalId, organizationId: auth.organizationId },
    select: { id: true, disposition: true, outcome: true },
  })
  if (!current) throw new ApiError('Work item not found', 404, 'WORK_NOT_FOUND')

  const refusal = refusePatch(
    {
      disposition: current.disposition as Disposition,
      outcome: current.outcome as Outcome,
    },
    patch,
  )
  if (refusal) throw new ApiError(refusal, 400, 'ILLEGAL_TRANSITION')

  const now = new Date()
  // updateMany, not update: the tenant guard requires organizationId in the
  // where clause, and `update` needs a unique key it cannot be part of. Same
  // shape as src/app/api/goals/[id]/recovery/route.ts.
  await prisma.goalWork.updateMany({
    where: { id: current.id, organizationId: auth.organizationId },
    data: {
      ...(patch.disposition !== undefined
        ? {
            disposition: patch.disposition,
            dispositionAt: now,
            dispositionBy: auth.dbUser.id,
          }
        : {}),
      ...(patch.outcome !== undefined
        ? { outcome: patch.outcome, outcomeAt: now, outcomeSource: 'human' }
        : {}),
      ...(patch.outcomeNote !== undefined ? { outcomeNote: patch.outcomeNote } : {}),
      ...(patch.assigneeUserId !== undefined ? { assigneeUserId: patch.assigneeUserId } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.skipReason !== undefined ? { skipReason: patch.skipReason } : {}),
      ...(patch.skipNote !== undefined ? { skipNote: patch.skipNote } : {}),
    },
  })

  // updateMany returns a count, so re-read the row to hand it back.
  const item = await prisma.goalWork.findFirst({
    where: { id: current.id, organizationId: auth.organizationId },
  })
  return { item }
}, { requires: 'member' })
