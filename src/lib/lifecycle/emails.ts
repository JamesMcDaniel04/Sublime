import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { sendLoggedEmail, type LoggedEmailResult } from '@/lib/email/logged'
import { unsubscribeUrl } from '@/lib/email/unsubscribe'
import * as templates from './templates'

const DAY_MS = 86_400_000
const SWEEP_TAKE = 500
type Tally = { sent: number; skipped: number; failed: number }

export function shouldRunLifecycleSweep(now: Date): boolean {
  return now.getUTCHours() === 15 && now.getUTCMinutes() < 15
}
function record(tally: Tally, result: LoggedEmailResult): void {
  if (result === 'sent') tally.sent += 1
  else if (result === 'failed') tally.failed += 1
  else tally.skipped += 1
}
async function adminsOf(organizationId: string, marketingOnly: boolean) {
  return systemPrisma.user.findMany({
    where: { organizationId, role: 'ADMIN', isActive: true, email: { not: null }, ...(marketingOnly ? { marketingEmailsOptOut: false } : {}) },
    select: { id: true, email: true },
    take: 20,
  })
}
async function marketingSend(
  tally: Tally,
  admin: { id: string; email: string | null },
  data: { organizationId: string; emailKey: string; dedupeKey: string; content: (unsubscribe: string) => { subject: string; html: string } },
): Promise<void> {
  const unsubscribe = unsubscribeUrl(admin.id)
  if (!unsubscribe) {
    tally.skipped += 1
    return
  }
  const content = data.content(unsubscribe)
  record(tally, await sendLoggedEmail({ organizationId: data.organizationId, userId: admin.id, emailKey: data.emailKey, dedupeKey: data.dedupeKey, to: admin.email!, subject: content.subject, html: content.html }))
}

async function dripSweep(tally: Tally, now: Date, appUrl: string | null): Promise<void> {
  const steps = [
    { key: 'drip-day2', days: 2, where: { goals: { none: {} } }, template: templates.dripDay2Email },
    { key: 'drip-day5', days: 5, where: { integrations: { none: {} }, nangoConnections: { none: {} } }, template: templates.dripDay5Email },
  ] as const
  for (const step of steps) {
    try {
      const organizations = await systemPrisma.organization.findMany({
        where: { createdAt: { lte: new Date(now.getTime() - step.days * DAY_MS), gte: new Date(now.getTime() - 90 * DAY_MS) }, ...step.where },
        select: { id: true }, take: SWEEP_TAKE,
      })
      for (const organization of organizations) {
        try {
          for (const admin of await adminsOf(organization.id, true)) {
            await marketingSend(tally, admin, {
              organizationId: organization.id, emailKey: step.key, dedupeKey: `${step.key}:${admin.id}`,
              content: (unsubscribe) => step.template({ appUrl, unsubscribeUrl: unsubscribe }),
            })
          }
        } catch (error) {
          apiLogger.warn('lifecycle: org sweep failed', { organizationId: organization.id, step: step.key, error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (error) {
      apiLogger.warn('lifecycle: step scan failed', { step: step.key, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

async function trialSweep(tally: Tally, now: Date, appUrl: string | null): Promise<void> {
  const steps = [
    { key: 'trial-3d', daysLeft: 3 as const, after: new Date(now.getTime() + DAY_MS), before: new Date(now.getTime() + 3 * DAY_MS) },
    { key: 'trial-1d', daysLeft: 1 as const, after: now, before: new Date(now.getTime() + DAY_MS) },
  ]
  for (const step of steps) {
    const organizations = await systemPrisma.organization.findMany({
      where: { firstPaidAt: null, trialEndsAt: { gt: step.after, lte: step.before } },
      select: { id: true, trialEndsAt: true }, take: SWEEP_TAKE,
    }).catch((error) => {
      apiLogger.warn('lifecycle: trial scan failed', { step: step.key, error: error instanceof Error ? error.message : String(error) })
      return []
    })
    for (const organization of organizations) {
      try {
        const content = templates.trialEndingEmail({ daysLeft: step.daysLeft, trialEndsAt: organization.trialEndsAt!, appUrl })
        for (const admin of await adminsOf(organization.id, false)) {
          record(tally, await sendLoggedEmail({ organizationId: organization.id, userId: admin.id, emailKey: step.key, dedupeKey: `${step.key}:${organization.id}:${admin.id}`, to: admin.email!, subject: content.subject, html: content.html }))
        }
      } catch (error) {
        apiLogger.warn('lifecycle: org sweep failed', { organizationId: organization.id, step: step.key, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}

async function winbackSweep(tally: Tally, now: Date, appUrl: string | null): Promise<void> {
  const inactiveCutoff = new Date(now.getTime() - 14 * DAY_MS)
  const steps = [
    {
      key: 'winback-inactive',
      where: { firstPaidAt: { not: null }, plan: { not: 'TRIAL' as const }, users: { some: { lastSeenAt: { lt: inactiveCutoff } }, none: { lastSeenAt: { gte: inactiveCutoff } } } },
      template: templates.winbackInactiveEmail,
    },
    {
      key: 'winback-cancelled',
      // No canceledAt exists. updatedAt is an intentionally coarse threshold;
      // the dedupe key makes this once-ever, so exact timing is not material.
      where: { plan: 'TRIAL' as const, firstPaidAt: { not: null }, stripeSubscriptionId: null, updatedAt: { lte: new Date(now.getTime() - 7 * DAY_MS) } },
      template: templates.winbackCancelledEmail,
    },
  ]
  for (const step of steps) {
    const organizations = await systemPrisma.organization.findMany({ where: step.where, select: { id: true }, take: SWEEP_TAKE }).catch((error) => {
      apiLogger.warn('lifecycle: win-back scan failed', { step: step.key, error: error instanceof Error ? error.message : String(error) })
      return []
    })
    for (const organization of organizations) {
      try {
        for (const admin of await adminsOf(organization.id, true)) {
          await marketingSend(tally, admin, {
            organizationId: organization.id, emailKey: step.key, dedupeKey: `${step.key}:${organization.id}:${admin.id}`,
            content: (unsubscribe) => step.template({ appUrl, unsubscribeUrl: unsubscribe }),
          })
        }
      } catch (error) {
        apiLogger.warn('lifecycle: org sweep failed', { organizationId: organization.id, step: step.key, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}

export async function runLifecycleSweep(now = new Date()): Promise<Tally> {
  const tally: Tally = { sent: 0, skipped: 0, failed: 0 }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || null
  await dripSweep(tally, now, appUrl)
  await trialSweep(tally, now, appUrl)
  await winbackSweep(tally, now, appUrl)
  return tally
}
