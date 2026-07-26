import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { notify } from '@/lib/notifications/service'
import { emailConfigured, sendEmail } from '@/lib/integrations/email'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MAX_GOALS_PER_ORG = 200
const MAX_CONTRIBUTIONS_PER_GOAL = 50

export type DigestGoal = {
  name: string
  riskLevel: string
  currentValue: number | null
  expectedValue: number
  weekDelta: number | null
  attributedRuns: number
  settled: Array<{ outcome: string; periodEnd: Date }>
}

export function formatGoalDigest(
  goals: DigestGoal[],
  appUrl?: string,
): {
  text: string
  html: string
} {
  const lines = goals.map((goal) => {
    const current = goal.currentValue === null ? 'no current reading' : goal.currentValue.toLocaleString('en-US')
    const delta =
      goal.weekDelta === null
        ? 'no week-over-week comparison'
        : `${goal.weekDelta >= 0 ? '+' : ''}${goal.weekDelta.toLocaleString('en-US')} this week`
    const settled = goal.settled.map((period) => period.outcome).join(', ')
    return `${goal.name} — ${goal.riskLevel.replace('_', ' ')}; ${current} vs ${goal.expectedValue.toLocaleString('en-US')} pace; ${delta}; ${goal.attributedRuns} attributed runs${settled ? `; settled: ${settled}` : ''}.`
  })
  const text = ['Your goals this week', ...lines.map((line) => `• ${line}`)].join('\n')
  // Relative links are dead in mail clients — only render the CTA when an
  // absolute base URL is configured.
  const cta = appUrl ? `<p><a href="${appUrl.replace(/\/$/, '')}/goals">Open goals</a></p>` : ''
  const html = [
    '<h1>Your goals this week</h1>',
    '<ul>',
    ...lines.map((line) => `<li>${escapeHtml(line)}</li>`),
    '</ul>',
    cta,
  ].join('')
  return { text, html }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function shouldRunWeeklyGoalDigest(now: Date): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() === 14 && now.getUTCMinutes() < 15
}

async function claimDigest(userId: string, organizationId: string, now: Date): Promise<boolean> {
  const iso = now.toISOString()
  // systemPrisma raw write: cross-tenant sweep bookkeeping on users.metadata,
  // CRON_SECRET-gated at the route; the org id is part of the predicate.
  // The interval is 6 days, not 7: the fire window is one 15-minute slot per
  // week, so a full-week predicate would skip a week whenever this run lands
  // a few minutes earlier in the window than the last one.
  const affected = await systemPrisma.$executeRaw`
    UPDATE users
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lastGoalDigestAt}', to_jsonb(${iso}::text))
    WHERE id = ${userId}
      AND "organizationId" = ${organizationId}::uuid
      AND (
        COALESCE(metadata->>'lastGoalDigestAt', '') = ''
        OR (metadata->>'lastGoalDigestAt')::timestamptz < (${iso}::timestamptz - interval '6 days')
      )
  `
  return affected > 0
}

type OrgGoalRow = {
  id: string
  name: string
  riskLevel: string
  ownerUserId: string | null
  startValue: number
  targetValue: number
  startAt: Date
  targetDate: Date
  metrics: Array<{ datapoints: Array<{ value: number; capturedAt: Date }> }>
  periods: Array<{ outcome: string; periodEnd: Date }>
  contributions: Array<{ resourceType: string; resourceId: string; createdAt: Date }>
}

/** Digest entry for one goal — computed ONCE per goal per sweep, then shared
 *  across every recipient who can see it (org goals are identical for all). */
async function digestGoalFor(
  organizationId: string,
  goal: OrgGoalRow,
  now: Date,
  weekAgo: Date,
): Promise<DigestGoal> {
  const points = goal.metrics[0]?.datapoints ?? []
  const latest = points[0] ?? null
  const prior = points.find((point) => point.capturedAt.getTime() <= weekAgo.getTime())
  const elapsed = now.getTime() - goal.startAt.getTime()
  const duration = Math.max(1, goal.targetDate.getTime() - goal.startAt.getTime())
  const expectedProgress = Math.min(1, Math.max(0, elapsed / duration))
  const expectedValue = goal.startValue + expectedProgress * (goal.targetValue - goal.startValue)
  let attributedRuns = 0
  for (const contribution of goal.contributions) {
    const since =
      contribution.createdAt.getTime() > weekAgo.getTime() ? contribution.createdAt : weekAgo
    attributedRuns +=
      contribution.resourceType === 'flow'
        ? await prisma.flowRun.count({
            where: {
              organizationId,
              flowId: contribution.resourceId,
              status: 'succeeded',
              startedAt: { gte: since, lte: now },
            },
          })
        : await prisma.agentExecution.count({
            where: {
              organizationId,
              agentTaskId: contribution.resourceId,
              completedAt: { gte: since, lte: now },
              error: null,
            },
          })
  }
  return {
    name: goal.name,
    riskLevel: goal.riskLevel,
    currentValue: latest?.value ?? null,
    expectedValue,
    weekDelta: latest && prior ? latest.value - prior.value : null,
    attributedRuns,
    settled: goal.periods,
  }
}

export async function sendWeeklyGoalDigests(
  now = new Date(),
): Promise<{ users: number; sent: number }> {
  let users = 0
  let sent = 0
  const weekAgo = new Date(now.getTime() - WEEK_MS)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || undefined

  // systemPrisma: global CRON_SECRET-gated sweep; all emitted content is
  // rebuilt inside each recipient's normal goal-visibility boundary.
  const orgs = await systemPrisma.goal
    .groupBy({ by: ['organizationId'], where: { status: 'active' } })
    .catch((error) => {
      apiLogger.warn('goals.digest: org scan failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return [] as Array<{ organizationId: string }>
    })

  for (const { organizationId } of orgs) {
    // One org's failure never starves the remaining orgs.
    try {
      const goals = await prisma.goal.findMany({
        where: { organizationId, status: 'active' },
        include: {
          metrics: {
            where: { role: 'primary' },
            take: 1,
            include: {
              datapoints: {
                orderBy: { capturedAt: 'desc' },
                take: 30,
                select: { value: true, capturedAt: true },
              },
            },
          },
          periods: {
            where: { periodEnd: { gte: weekAgo, lte: now } },
            select: { outcome: true, periodEnd: true },
          },
          contributions: {
            take: MAX_CONTRIBUTIONS_PER_GOAL,
            orderBy: { createdAt: 'desc' },
            select: { resourceType: true, resourceId: true, createdAt: true },
          },
        },
        take: MAX_GOALS_PER_ORG,
      })
      if (goals.length === 0) continue

      // Compute each goal's digest entry once; recipients share them.
      const entryByGoal = new Map<string, DigestGoal>()
      for (const goal of goals) {
        entryByGoal.set(goal.id, await digestGoalFor(organizationId, goal, now, weekAgo))
      }

      const recipients = await systemPrisma.user.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, email: true },
        take: 500,
      })
      for (const user of recipients) {
        // One user's failure never starves the remaining recipients.
        try {
          const visible = goals.filter(
            (goal) => goal.ownerUserId === null || goal.ownerUserId === user.id,
          )
          if (visible.length === 0) continue
          if (!(await claimDigest(user.id, organizationId, now))) continue
          users += 1

          const digestGoals = visible.flatMap((goal) => {
            const entry = entryByGoal.get(goal.id)
            return entry ? [entry] : []
          })
          const content = formatGoalDigest(digestGoals, appUrl)
          const notification = await notify({
            organizationId,
            userId: user.id,
            type: 'goal.digest',
            level: 'info',
            title: 'Your goals this week',
            body: content.text,
            link: '/goals',
          })
          if (notification) sent += 1
          if (user.email && emailConfigured()) {
            await sendEmail({
              to: user.email,
              subject: 'Your goals this week',
              body: content.html,
            }).catch((error) => {
              apiLogger.warn('goals.digest: email failed', {
                userId: user.id,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }
        } catch (error) {
          apiLogger.warn('goals.digest: recipient failed', {
            userId: user.id,
            organizationId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      apiLogger.warn('goals.digest: org failed', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { users, sent }
}
