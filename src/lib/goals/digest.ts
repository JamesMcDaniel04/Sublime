import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { notify } from '@/lib/notifications/service'
import { emailConfigured, sendEmail } from '@/lib/integrations/email'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export type DigestGoal = {
  name: string
  riskLevel: string
  currentValue: number | null
  expectedValue: number
  weekDelta: number | null
  attributedRuns: number
  settled: Array<{ outcome: string; periodEnd: Date }>
}

export function formatGoalDigest(goals: DigestGoal[]): {
  text: string
  html: string
} {
  const lines = goals.map((goal) => {
    const current = goal.currentValue === null ? 'no current reading' : goal.currentValue.toLocaleString()
    const delta =
      goal.weekDelta === null
        ? 'no week-over-week comparison'
        : `${goal.weekDelta >= 0 ? '+' : ''}${goal.weekDelta.toLocaleString()} this week`
    const settled = goal.settled.map((period) => period.outcome).join(', ')
    return `${goal.name} — ${goal.riskLevel.replace('_', ' ')}; ${current} vs ${goal.expectedValue.toLocaleString()} pace; ${delta}; ${goal.attributedRuns} attributed runs${settled ? `; settled: ${settled}` : ''}.`
  })
  const text = ['Your goals this week', ...lines.map((line) => `• ${line}`)].join('\n')
  const html = [
    '<h1>Your goals this week</h1>',
    '<ul>',
    ...lines.map((line) => `<li>${escapeHtml(line)}</li>`),
    '</ul>',
    '<p><a href="/goals">Open goals</a></p>',
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
  const affected = await systemPrisma.$executeRaw`
    UPDATE users
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lastGoalDigestAt}', to_jsonb(${iso}::text))
    WHERE id = ${userId}
      AND "organizationId" = ${organizationId}::uuid
      AND (
        COALESCE(metadata->>'lastGoalDigestAt', '') = ''
        OR (metadata->>'lastGoalDigestAt')::timestamptz < (${iso}::timestamptz - interval '7 days')
      )
  `
  return affected > 0
}

export async function sendWeeklyGoalDigests(
  now = new Date(),
): Promise<{ users: number; sent: number }> {
  try {
    // systemPrisma: global CRON_SECRET-gated sweep; all emitted content is
    // rebuilt inside each recipient's normal goal-visibility boundary.
    const orgs = await systemPrisma.goal.groupBy({
      by: ['organizationId'],
      where: { status: 'active' },
    })
    let users = 0
    let sent = 0
    const weekAgo = new Date(now.getTime() - WEEK_MS)

    for (const { organizationId } of orgs) {
      const recipients = await systemPrisma.user.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, email: true },
        take: 500,
      })
      for (const user of recipients) {
        const goals = await prisma.goal.findMany({
          where: {
            organizationId,
            status: 'active',
            OR: [{ ownerUserId: null }, { ownerUserId: user.id }],
          },
          include: {
            metrics: {
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
              select: {
                resourceType: true,
                resourceId: true,
                createdAt: true,
              },
            },
          },
          take: 50,
        })
        if (goals.length === 0) continue
        users += 1
        if (!(await claimDigest(user.id, organizationId, now))) continue

        const digestGoals: DigestGoal[] = []
        for (const goal of goals) {
          const points = goal.metrics[0]?.datapoints ?? []
          const latest = points[0] ?? null
          const prior = points.find((point) => point.capturedAt.getTime() <= weekAgo.getTime())
          const elapsed = now.getTime() - goal.startAt.getTime()
          const duration = Math.max(1, goal.targetDate.getTime() - goal.startAt.getTime())
          const expectedProgress = Math.min(1, Math.max(0, elapsed / duration))
          const expectedValue =
            goal.startValue + expectedProgress * (goal.targetValue - goal.startValue)
          let attributedRuns = 0
          for (const contribution of goal.contributions) {
            const since =
              contribution.createdAt.getTime() > weekAgo.getTime()
                ? contribution.createdAt
                : weekAgo
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
          digestGoals.push({
            name: goal.name,
            riskLevel: goal.riskLevel,
            currentValue: latest?.value ?? null,
            expectedValue,
            weekDelta:
              latest && prior ? latest.value - prior.value : null,
            attributedRuns,
            settled: goal.periods,
          })
        }
        const content = formatGoalDigest(digestGoals)
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
      }
    }
    return { users, sent }
  } catch (error) {
    apiLogger.warn('goals.digest: sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { users: 0, sent: 0 }
  }
}
