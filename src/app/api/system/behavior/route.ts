/**
 * /api/system/behavior — operator seam for the behavior-intelligence pipeline.
 *
 * The LLM legs (synthesis, intent clustering) otherwise only execute on the
 * daily cron tick — "wait a day and grep logs" is no way to verify a deploy.
 * This endpoint runs the pipeline on demand and returns the full result
 * chain (including every skip reason), and can rebuild the graph projection
 * from the user_events ledger (the ledger is the source of truth; the graph
 * is a rebuildable view — this is the rebuild button).
 *
 * Auth (fail closed): Authorization: Bearer <CRON_SECRET>, same contract as
 * the cron routes. Operator tooling, never end-user-facing.
 */
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { inferUserBehaviorPatterns } from '@/lib/behavior/infer-user-patterns'
import { sweepUnindexedUserEvents } from '@/lib/behavior/index-user-event'
import { runBehaviorIntelligence } from '@/lib/behavior/run-behavior-intelligence'
import { synthesizeUserSuggestions } from '@/lib/intelligence/suggest-user-workflows'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  action: z.enum(['run-user', 'run-org', 'sweep', 'rebuild-graph']),
  organizationId: z.string().min(1),
  userId: z.string().min(1).optional(),
})

function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function POST(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ success: false, error: 'action + organizationId required (userId for run-user)' }, { status: 400 })
  }
  const { action, organizationId, userId } = parsed.data

  try {
    switch (action) {
      case 'run-user': {
        if (!userId) return Response.json({ success: false, error: 'userId is required for run-user' }, { status: 400 })
        // Synchronous, verbose: the whole point is seeing the skip chain.
        const inference = await inferUserBehaviorPatterns(organizationId, userId)
        const synthesis = await synthesizeUserSuggestions(organizationId, userId)
        return Response.json({ success: true, action, inference, synthesis })
      }
      case 'run-org': {
        const stats = await runBehaviorIntelligence(organizationId)
        return Response.json({ success: true, action, stats })
      }
      case 'sweep': {
        const swept = await sweepUnindexedUserEvents()
        return Response.json({ success: true, action, swept })
      }
      case 'rebuild-graph': {
        // Reset the projection gate for this org, then re-project a first
        // batch; the cron sweep works down the remainder every 15 minutes.
        // systemPrisma justification: operator path, CRON_SECRET-gated —
        // though this write IS org-scoped.
        const reset = (await systemPrisma.userEvent.updateMany({
          where: { organizationId },
          data: { indexedAt: null },
        })).count
        const swept = await sweepUnindexedUserEvents()
        return Response.json({ success: true, action, reset, sweptFirstBatch: swept })
      }
    }
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : 'behavior operation failed' },
      { status: 500 },
    )
  }
}
