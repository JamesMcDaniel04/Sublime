import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { emailConfigured, sendRawEmail } from './send'

const MAX_ATTEMPTS = 3
export type LoggedEmailResult = 'sent' | 'duplicate' | 'failed' | 'unconfigured'

export async function sendLoggedEmail(input: {
  organizationId: string; userId?: string | null; emailKey: string; dedupeKey: string
  to: string; subject: string; html: string; replyTo?: string
}): Promise<LoggedEmailResult> {
  if (!emailConfigured()) return 'unconfigured'
  let claimId: string
  try {
    const claim = await prisma.emailSend.create({
      data: { organizationId: input.organizationId, userId: input.userId ?? null, emailKey: input.emailKey, dedupeKey: input.dedupeKey, to: input.to, subject: input.subject },
      select: { id: true },
    })
    claimId = claim.id
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    const retaken = await prisma.emailSend.updateMany({
      where: { dedupeKey: input.dedupeKey, status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } },
      data: { status: 'PENDING', attempts: { increment: 1 }, error: null },
    })
    if (retaken.count === 0) return 'duplicate'
    const row = await prisma.emailSend.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } })
    if (!row) return 'duplicate'
    claimId = row.id
  }
  try {
    await sendRawEmail({ to: input.to, subject: input.subject, html: input.html, replyTo: input.replyTo })
    await prisma.emailSend.update({ where: { id: claimId }, data: { status: 'SENT', sentAt: new Date(), error: null } })
    return 'sent'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    apiLogger.warn('email: logged send failed', { emailKey: input.emailKey, dedupeKey: input.dedupeKey, error: message })
    await prisma.emailSend.update({ where: { id: claimId }, data: { status: 'FAILED', error: message.slice(0, 500) } }).catch(() => {})
    return 'failed'
  }
}
