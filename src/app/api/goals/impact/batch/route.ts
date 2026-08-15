import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { goalImpactBatch } from '@/lib/goals/impact'
import { goalReadWhere } from '@/lib/server/goal-scope'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/** Hard cap: the Home strip shows at most 3 goals; anything more is misuse. */
const MAX_IDS = 3

// GET /api/goals/impact/batch?ids=a,b,c — per-goal impact tiers for the Home
// strip. Ids the caller may not see are silently dropped (absent, never 403 —
// the confidential-goal rule). Flat query count regardless of ids.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const ids = (request.nextUrl.searchParams.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (ids.length === 0 || ids.length > MAX_IDS) {
    return NextResponse.json(
      { success: false, error: `ids must list 1-${MAX_IDS} goal ids` },
      { status: 400 },
    )
  }
  const visible = await prisma.goal.findMany({
    where: {
      organizationId: auth.organizationId,
      id: { in: ids },
      ...goalReadWhere(auth.dbUser.id, { isAdmin: auth.isAdmin }),
    },
    select: { id: true },
  })
  const impact = await goalImpactBatch(
    auth.organizationId,
    visible.map((goal) => goal.id),
  )
  return { success: true, impact: Object.fromEntries(impact) }
}, { requires: 'member' })
