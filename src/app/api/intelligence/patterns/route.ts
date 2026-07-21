import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { isPatternEligible } from '@/lib/behavior/eligibility'

export const runtime = 'nodejs'

// Transparency surface: everything Sublime has learned about THIS user (their
// open behavior patterns, eligibility state) plus the org's persona summary.
// Patterns are visible before they ever ground a suggestion — trust comes
// from showing the evidence early, and early dismissals feed the existing
// similarity-suppression loop before a suggestion is ever spent on them.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [patterns, firstEvent, persona] = await Promise.all([
    prisma.userPattern.findMany({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id, status: 'open' },
      orderBy: { occurrenceCount: 'desc' },
      take: 50,
    }),
    prisma.userEvent.findFirst({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    }),
    prisma.organizationPersona
      .findUnique({
        where: { organizationId: auth.organizationId },
        select: { narrative: true, departmentWeights: true, computedAt: true },
      })
      .catch(() => null),
  ])
  const weights = (persona?.departmentWeights ?? {}) as Record<string, number>
  const topDepartments = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .filter(([, weight]) => weight > 0)
    .slice(0, 3)
    .map(([department]) => department)
  return {
    success: true,
    persona: persona
      ? { narrative: persona.narrative, topDepartments, computedAt: persona.computedAt }
      : null,
    patterns: patterns.map((pattern) => ({
      slug: pattern.slug,
      kind: pattern.kind,
      summary: pattern.summary,
      occurrenceCount: pattern.occurrenceCount,
      firstSeenAt: pattern.firstSeenAt,
      lastSeenAt: pattern.lastSeenAt,
      eligible: isPatternEligible(pattern, firstEvent?.occurredAt ?? null),
    })),
  }
})

// Dismiss one pattern by slug. Status 'dismissed' is load-bearing: the
// inference job's similarity check suppresses lookalike patterns from then
// on — the same loop a suggestion dismissal feeds, reachable earlier.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { slug } = z.object({ slug: z.string().min(1) }).parse(await request.json())
  const result = await prisma.userPattern.updateMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, slug, status: 'open' },
    data: { status: 'dismissed' },
  })
  if (result.count === 0) throw new ApiError('Pattern not found', 404, 'NOT_FOUND')
  return { success: true }
})
