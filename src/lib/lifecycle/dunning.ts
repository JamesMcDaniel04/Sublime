import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { sendLoggedEmail } from '@/lib/email/logged'
import { dunningEmail } from './templates'

export async function sendDunningEmails(invoice: { id?: string | null; customer?: string | { id: string } | null }): Promise<void> {
  const invoiceId = invoice.id ?? null
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  if (!invoiceId || !customerId) return
  const organization = await prisma.organization.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } })
  if (!organization) return
  const admins = await prisma.user.findMany({
    where: { organizationId: organization.id, role: 'ADMIN', isActive: true, email: { not: null } },
    select: { id: true, email: true }, take: 20,
  })
  const content = dunningEmail({ appUrl: process.env.NEXT_PUBLIC_APP_URL || null })
  for (const admin of admins) {
    const result = await sendLoggedEmail({
      organizationId: organization.id, userId: admin.id, emailKey: 'dunning',
      dedupeKey: `dunning:${invoiceId}:${admin.id}`, to: admin.email!,
      subject: content.subject, html: content.html,
    })
    if (result === 'failed') apiLogger.warn('dunning: send failed', { organizationId: organization.id, invoiceId })
  }
}
